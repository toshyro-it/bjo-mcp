import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { parseConfig } from "./config.js";
import { createApiClient } from "./api.js";
import { createBjoServer } from "./server.js";
// Only fixed, allowlisted diagnostics. Never pass an exception/reason/config to a writer.
function report(code) {
    process.stderr.write(`${code}\n`);
    process.exitCode = 1;
}
function start() {
    let config;
    try {
        config = parseConfig(process.env);
    }
    catch {
        report("invalid_config");
        return;
    }
    const api = createApiClient(config, { fetch: globalThis.fetch });
    let handle;
    let closing;
    const close = () => closing ??= Promise.resolve()
        .then(() => handle?.close())
        .catch(() => { report("shutdown_error"); })
        .finally(() => {
        process.off("SIGINT", onSignal);
        process.off("SIGTERM", onSignal);
    });
    const onSignal = () => { void close(); };
    process.on("SIGINT", onSignal);
    process.on("SIGTERM", onSignal);
    try {
        handle = serveStdio(() => createBjoServer({ api }), {
            // legacy defaults to 'serve': same factory, no hand-written negotiation.
            onerror: () => { report("stdio_error"); void close(); },
        });
    }
    catch {
        report("startup_error");
        void close();
    }
    // EOF is owned by serveStdio: it aborts pending ctx signals and closes transport.
    // Native fetch owns no custom pool/timer here; adapter clears its deadline in finally.
}
start();
