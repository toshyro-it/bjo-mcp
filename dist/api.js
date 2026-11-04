import { projectRevision, revisionSchema, updateTaskInputSchema } from "./revisions.js";
import { createTaskInputSchema, getTaskInputSchema, makeOutput, projectResponse, } from "./contracts.js";
export const REQUEST_BYTE_LIMIT = 65_536;
export const RESPONSE_BYTE_LIMIT = 262_144;
export const DEADLINE_MS = 15_000;
const clockDefault = {
    now: () => Date.now(),
    setTimeout: (callback, ms) => setTimeout(callback, ms),
    clearTimeout: handle => clearTimeout(handle),
};
export function parseRetryAfter(raw, now) {
    if (raw === null)
        return undefined;
    if (/^[0-9]+$/.test(raw)) {
        const seconds = Number(raw);
        return Number.isSafeInteger(seconds) ? seconds : undefined;
    }
    if (!/^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), [0-9]{2} (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) [0-9]{4} [0-9]{2}:[0-9]{2}:[0-9]{2} GMT$/.test(raw))
        return undefined;
    const time = Date.parse(raw);
    if (!Number.isFinite(time) || new Date(time).toUTCString() !== raw)
        return undefined;
    const seconds = Math.max(0, Math.ceil((time - now) / 1000));
    return Number.isSafeInteger(seconds) ? seconds : undefined;
}
/** One request, fixed destination. No ambient fetch, retries, cookies, logging or reconciliation. */
export function createApiClient(config, dependencies) {
    const { origin, token } = config; // Capture validated private values; caller mutation cannot redirect in-flight calls.
    const request = dependencies.fetch;
    const clock = dependencies.clock ?? clockDefault;
    async function call(operation, raw, signal) {
        const post = operation === "POST" || operation === "PATCH";
        const extended = operation === "REVISION" || operation === "PATCH";
        const notSent = post ? { submission: "not_sent" } : {};
        const parsed = (operation === "PATCH" ? updateTaskInputSchema : operation === "POST" ? createTaskInputSchema : getTaskInputSchema).safeParse(raw);
        if (!parsed.success)
            return makeOutput("invalid_input", notSent);
        const input = parsed.data;
        const patch = operation === "PATCH" ? updateTaskInputSchema.parse(input) : undefined;
        const body = post ? JSON.stringify(patch ? patch.changes : input) : undefined;
        if (body !== undefined && new TextEncoder().encode(body).byteLength > REQUEST_BYTE_LIMIT) {
            return makeOutput("payload_too_large", notSent);
        }
        if (signal.aborted)
            return makeOutput("cancelled", notSent);
        const url = new URL(operation === "REVISION" ? "/v1/integrations/tasks/revision" : "/v1/integrations/tasks", origin);
        if (operation !== "POST")
            url.search = new URLSearchParams({ source: input.source, externalId: input.externalId }).toString();
        const controller = new AbortController();
        let timedOut = false;
        let response;
        let observedStatus;
        let reader;
        let fullyRead = false;
        let sent = false;
        // Race both headers and EVERY read, even if injected transport ignores AbortSignal.
        let rejectInterrupted;
        const interrupted = new Promise((_, reject) => {
            rejectInterrupted = () => reject(new Error("request_interrupted"));
        });
        controller.signal.addEventListener("abort", rejectInterrupted, { once: true });
        const cancel = () => controller.abort(); // Never propagate signal.reason.
        signal.addEventListener("abort", cancel, { once: true });
        const timer = clock.setTimeout(() => { timedOut = true; controller.abort(); }, DEADLINE_MS);
        try {
            if (signal.aborted)
                controller.abort();
            if (controller.signal.aborted)
                await interrupted;
            sent = true;
            const pending = request(url, {
                method: operation === "REVISION" ? "GET" : operation, redirect: "error", credentials: "omit", signal: controller.signal,
                headers: { Accept: "application/json", Authorization: `Bearer ${token}`,
                    ...(post ? { "Content-Type": "application/json" } : {}), ...(patch ? { "If-Match": patch.expectedRevision } : {}) },
                ...(body !== undefined ? { body } : {}),
            }).then(received => {
                if (controller.signal.aborted) {
                    void received.body?.cancel().catch(() => undefined);
                    throw new Error("request_interrupted");
                }
                return received;
            });
            response = await Promise.race([pending, interrupted]);
            // Opaque/error Response has status 0, not an observed HTTP status. Do not
            // invent one or let the output validator throw raw diagnostics for it.
            if (!Number.isInteger(response.status) || response.status < 100 || response.status > 599)
                throw new Error("invalid_response");
            observedStatus = response.status;
            const mime = response.headers.get("content-type")?.split(";", 1)[0]?.trim();
            if (!mime || !/^application\/(?:[a-z0-9!#$&^_.+-]+\+)?json$/i.test(mime))
                throw new Error("invalid_response");
            const length = response.headers.get("content-length");
            if (length !== null && (!/^[0-9]+$/.test(length) || Number(length) > RESPONSE_BYTE_LIMIT))
                throw new Error("invalid_response");
            if (!response.body)
                throw new Error("invalid_response");
            reader = response.body.getReader();
            const decoder = new TextDecoder("utf-8", { fatal: true });
            let bytes = 0;
            let text = "";
            while (true) {
                const chunk = await Promise.race([reader.read(), interrupted]);
                if (chunk.done) {
                    fullyRead = true;
                    break;
                }
                bytes += chunk.value.byteLength;
                if (bytes > RESPONSE_BYTE_LIMIT)
                    throw new Error("invalid_response");
                text += decoder.decode(chunk.value, { stream: true });
            }
            text += decoder.decode();
            if (controller.signal.aborted)
                await interrupted;
            const wire = JSON.parse(text);
            if (extended && [200, 410, 412, 428].includes(response.status))
                return projectRevision(response.status, wire, input, operation === "PATCH", response.headers.get("etag"));
            const output = projectResponse(post ? "POST" : "GET", response.status, wire, input, response.status === 429 ? parseRetryAfter(response.headers.get("retry-after"), clock.now()) : undefined);
            if (operation === "GET" && output.outcome === "current" && response.headers.has("etag")) {
                const rev = revisionSchema.safeParse(response.headers.get("etag"));
                if (!rev.success)
                    return makeOutput("invalid_response", { httpStatus: response.status });
                return { ...output, revision: rev.data };
            }
            return output;
        }
        catch {
            const outcome = controller.signal.aborted ? timedOut ? "timeout" : "cancelled"
                : response ? "invalid_response" : "transport_error";
            return makeOutput(outcome, {
                ...(observedStatus !== undefined ? { httpStatus: observedStatus } : {}),
                ...(post ? { submission: sent ? "unknown" : "not_sent" } : {}),
            });
        }
        finally {
            clock.clearTimeout(timer);
            signal.removeEventListener("abort", cancel);
            controller.signal.removeEventListener("abort", rejectInterrupted);
            // Cancel first, release immediately; an uncooperative source's cancel promise
            // must not keep a tool call hanging beyond its deadline.
            if (!fullyRead) {
                if (reader)
                    void reader.cancel().catch(() => undefined);
                else if (response?.body)
                    void response.body.cancel().catch(() => undefined);
            }
            reader?.releaseLock();
            controller.abort();
        }
    }
    return {
        createTask: (input, signal) => call("POST", input, signal),
        getTask: (input, signal) => call("GET", input, signal),
        getTaskRevision: (input, signal) => call("REVISION", input, signal),
        updateTask: (input, signal) => call("PATCH", input, signal),
    };
}
