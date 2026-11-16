import { z } from "zod";
import { getTaskInputSchema, makeOutput, toolOutputSchema, upstreamEnvelopeSchema, validDate, } from "./contracts.js";
export const revisionSchema = z.string().refine(value => /^"task-v1-[0-9a-f]{32}-[1-9][0-9]{0,18}"$/.test(value)
    && BigInt(value.slice(42, -1)) <= 9223372036854775807n);
/**
 * A compressing edge downgrades ETag to W/"..." even though the body revision is
 * strong. The weak form is a transport artefact: strip only the exact W/ prefix
 * and keep the opaque value, which stays the If-Match value verbatim.
 */
export function parseRevisionTag(raw) {
    if (raw === null || raw === undefined)
        return undefined;
    const parsed = revisionSchema.safeParse(raw.startsWith("W/") ? raw.slice(2) : raw);
    return parsed.success ? parsed.data : undefined;
}
const date = z.string().refine(validDate);
export const changesSchema = z.strictObject({
    title: z.string().min(1).max(200).optional(), details: z.string().max(16384).nullable().optional(),
    startDate: date.nullable().optional(), dueDate: date.nullable().optional(), priority: z.boolean().optional(),
}).refine(value => Object.keys(value).length > 0);
export const updateTaskInputSchema = getTaskInputSchema.extend({
    expectedRevision: revisionSchema, changes: changesSchema,
});
export const metadataSchema = z.strictObject({
    revision: revisionSchema, updatedAt: z.string().datetime({ offset: true }),
    state: z.enum(["aberta", "concluida", "cancelada", "pausada", "bloqueada"]),
    hashVersion: z.literal(1), contentHash: z.string().regex(/^[0-9a-f]{64}$/),
});
const identityView = getTaskInputSchema.extend({ taskId: z.string().uuid().refine(value => value !== "00000000-0000-0000-0000-000000000000") });
export const revisionViewSchema = z.discriminatedUnion("availability", [
    identityView.extend({ availability: z.literal("available"), metadata: metadataSchema }),
    identityView.extend({ availability: z.literal("deleted"), metadata: z.null() }),
]);
const successSchema = z.strictObject({
    outcome: z.enum(["revision", "updated", "unchanged"]), httpStatus: z.literal(200),
    data: revisionViewSchema.refine(v => v.availability === "available"),
    submission: z.literal("confirmed").optional(),
});
const deletedSchema = z.strictObject({ outcome: z.literal("deleted"), httpStatus: z.literal(410),
    data: revisionViewSchema.refine(v => v.availability === "deleted") });
const preconditionSchema = z.strictObject({ outcome: z.enum(["stale_revision", "precondition_required"]),
    httpStatus: z.union([z.literal(412), z.literal(428)]) });
export const revisionOutputSchema = z.union([successSchema, deletedSchema, preconditionSchema, toolOutputSchema]);
const envelope = z.object({ statusCode: z.number().int(), data: revisionViewSchema });
const updatedEnvelope = z.object({ statusCode: z.literal(200), data: z.object({
        outcome: z.enum(["updated", "unchanged"]), current: revisionViewSchema,
    }) });
export function projectRevision(status, wire, identity, update, etag, onInvalid) {
    const invalid = (code, rejectWrite = update) => {
        onInvalid?.(code);
        return makeOutput("invalid_response", { httpStatus: status, ...(rejectWrite ? { submission: "unknown" } : {}) });
    };
    if (status === 412 || status === 428) {
        const envelope = upstreamEnvelopeSchema.safeParse(wire);
        if (!envelope.success || envelope.data.statusCode !== status)
            return invalid("bad_envelope");
        return { outcome: status === 412 ? "stale_revision" : "precondition_required", httpStatus: status };
    }
    const parsed = update && status === 200 ? updatedEnvelope.safeParse(wire) : envelope.safeParse(wire);
    if (!parsed.success || parsed.data.statusCode !== status)
        return invalid("bad_envelope");
    const data = "current" in parsed.data.data ? parsed.data.data.current : parsed.data.data;
    if (data.source !== identity.source || data.externalId !== identity.externalId)
        return invalid("identity_mismatch");
    if (status === 200) {
        if (data.availability !== "available")
            return invalid("bad_envelope");
        // The body is the source of truth for the revision. The header only confirms
        // it: its weak form is accepted because the opaque value is unchanged, and an
        // absent header is not evidence against the body.
        if (etag !== null) {
            const header = parseRevisionTag(etag);
            if (header === undefined)
                return invalid("bad_revision_format");
            if (header !== data.metadata.revision)
                return invalid("revision_mismatch");
        }
        if (!data.metadata.revision.startsWith(`"task-v1-${data.taskId.replaceAll("-", "").toLowerCase()}-`))
            return invalid("bad_revision_format");
    }
    if (status === 410 && data.availability === "deleted")
        return { outcome: "deleted", httpStatus: 410, data };
    if (status !== 200 || data.availability !== "available")
        return invalid("bad_envelope", false);
    const outcome = update && "outcome" in parsed.data.data ? parsed.data.data.outcome : "revision";
    return { outcome, httpStatus: 200, data, ...(update ? { submission: "confirmed" } : {}) };
}
export function formatRevisionResult(output) {
    const parsed = revisionOutputSchema.safeParse(output);
    const safe = parsed.success ? parsed.data : makeOutput("invalid_response");
    return { isError: !["revision", "updated", "unchanged"].includes(safe.outcome),
        structuredContent: safe, content: [{ type: "text", text: JSON.stringify(safe) }] };
}
