/**
 * Ensures 127.0.0.1 and localhost are included in the NO_PROXY environment variable.
 * Prevents local MCP HTTP servers from being routed through a configured HTTP proxy.
 *
 * Handles both NO_PROXY and no_proxy (undici reads no_proxy first) by writing both,
 * and uses exact entry matching instead of substring search.
 */
export function ensureLocalProxyBypass(env: Record<string, string | undefined>): void {
    const localHosts = '127.0.0.1,localhost'
    const existing = env.NO_PROXY || env.no_proxy || ''
    const entries = existing.split(',').map(s => s.trim()).filter(Boolean)

    if (entries.includes('127.0.0.1')) return

    const updated = existing ? `${existing},${localHosts}` : localHosts
    env.NO_PROXY = updated
    env.no_proxy = updated
}
