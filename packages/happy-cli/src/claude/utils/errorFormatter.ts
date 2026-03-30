/**
 * Sanitize raw technical error messages into user-friendly display text.
 *
 * Strategy: try structured JSON extraction first, fall back to regex pattern matching.
 * Returns { display, raw } so callers can log `raw` and show `display`.
 */

interface ErrorFormatResult {
    display: string
    raw: string
}

interface ErrorRule {
    test: RegExp
    message: string
}

const ERROR_RULES: ErrorRule[] = [
    { test: /\b500\b/i,                          message: '⚠️ Anthropic 服务器内部错误 (500)，请稍后重试' },
    { test: /\b529\b|overloaded/i,                message: '⚠️ Anthropic API 过载 (529)，请稍后重试' },
    { test: /\b429\b|rate.?limit/i,               message: '⚠️ 请求频率超限，请等待后重试' },
    { test: /\b401\b|unauthorized|authentication/i, message: '⚠️ API 认证失败，请检查账户配置' },
    { test: /\b403\b|forbidden|permission.?denied/i, message: '⚠️ API 权限不足' },
    { test: /timeout|ETIMEDOUT|ECONNREFUSED|ECONNRESET/i, message: '⚠️ 连接超时或被拒绝，请检查网络' },
    { test: /ENOENT/i,                            message: '⚠️ 文件或路径不存在' },
    { test: /error_max_turns/i,                   message: '⚠️ 达到最大轮次限制' },
]

/**
 * Try to parse Anthropic-style structured error from the raw message.
 * Handles format: `API Error: {statusCode} {json}`
 * where json is `{"type":"error","error":{"type":"...","message":"..."}}`
 */
function tryParseStructuredError(raw: string): string | null {
    // Match "API Error: <code> <json>" pattern
    const apiErrorMatch = raw.match(/API Error:\s*(\d+)\s*(.+)/s)
    if (!apiErrorMatch) return null

    const statusCode = apiErrorMatch[1]
    const jsonPart = apiErrorMatch[2].trim()

    try {
        const parsed = JSON.parse(jsonPart)
        // Anthropic error format: { type: "error", error: { type: "...", message: "..." } }
        const errorType = parsed?.error?.type ?? parsed?.type ?? 'unknown'
        const errorMessage = parsed?.error?.message ?? parsed?.message ?? ''

        // Map known error types to friendly messages
        const typeMap: Record<string, string> = {
            'api_error':            `⚠️ Anthropic 服务器错误 (${statusCode})，请稍后重试`,
            'overloaded_error':     `⚠️ Anthropic API 过载 (${statusCode})，请稍后重试`,
            'rate_limit_error':     `⚠️ 请求频率超限 (${statusCode})，请等待后重试`,
            'authentication_error': `⚠️ API 认证失败 (${statusCode})，请检查账户配置`,
            'permission_error':     `⚠️ API 权限不足 (${statusCode})`,
            'invalid_request_error': `⚠️ 请求参数错误 (${statusCode}): ${errorMessage}`,
            'not_found_error':      `⚠️ API 资源不存在 (${statusCode})`,
        }

        return typeMap[errorType] ?? `⚠️ API 错误 (${statusCode}): ${errorMessage || errorType}`
    } catch {
        // JSON parse failed, return null to fall through to regex
        return null
    }
}

/**
 * Sanitize raw error message into user-friendly text.
 *
 * 1. Try structured JSON parsing (for Anthropic API errors)
 * 2. Fall back to regex pattern matching
 * 3. Default: truncate to 200 chars
 */
export function formatErrorForUser(rawMessage: string): ErrorFormatResult {
    const raw = rawMessage

    // Step 1: try structured parsing
    const structured = tryParseStructuredError(raw)
    if (structured) {
        return { display: structured, raw }
    }

    // Step 2: regex pattern matching
    for (const rule of ERROR_RULES) {
        if (rule.test.test(raw)) {
            return { display: rule.message, raw }
        }
    }

    // Step 3: fallback — strip obvious JSON blobs and truncate
    const cleaned = raw.replace(/\{[^}]{50,}\}/g, '[...]').trim()
    const display = cleaned.length > 200 ? cleaned.slice(0, 200) + '...' : cleaned
    return { display, raw }
}
