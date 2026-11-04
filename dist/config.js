/** No environment reads, defaults, I/O, or supplied values in errors. */
export function parseConfig(env) {
    const fail = () => { throw new Error("invalid_config"); };
    const raw = env.BJO_API_URL;
    const token = env.BJO_API_TOKEN;
    const flag = env.BJO_MCP_ALLOW_LOOPBACK_HTTP;
    if (!raw || !token || !token.trim() || /[^\x21-\x7e]/.test(token)
        || (flag !== undefined && flag !== "true" && flag !== "false"))
        return fail();
    // Inspect syntax BEFORE WHATWG normalization (userinfo, empty delimiters,
    // dot paths, backslashes, whitespace, and alternate IPv4 forms must not hide).
    const match = /^(https?):\/\/([^/?#\\\s]+)\/?$/.exec(raw);
    if (!match || match[2].includes("@"))
        return fail();
    let url;
    try {
        url = new URL(raw);
    }
    catch {
        return fail();
    }
    if (url.username || url.password || url.pathname !== "/" || url.search || url.hash)
        return fail();
    if (url.protocol === "http:" && (flag !== "true"
        || !/^(localhost|127\.0\.0\.1|\[::1\])(?::[0-9]+)?$/.test(match[2])))
        return fail();
    return Object.freeze({ origin: url.origin, token });
}
