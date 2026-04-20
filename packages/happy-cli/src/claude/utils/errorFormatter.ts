/**
 * Sanitize raw technical error messages into user-friendly display text
 * with structured severity classification and actionable recovery steps.
 *
 * Strategy: try structured JSON extraction first, fall back to regex pattern matching.
 * Returns { display, raw, severity, recoverySteps } so callers can log `raw`,
 * show `display`, and render recovery guidance.
 */

/** How severe the error is — determines retry strategy and UI treatment. */
export type ErrorSeverity = 'transient' | 'quota' | 'auth' | 'permanent'

export interface ErrorFormatResult {
    display: string
    raw: string
    severity: ErrorSeverity
    /** Ordered list of actionable recovery steps (may be empty for unknown errors). */
    recoverySteps: string[]
}

interface ErrorRule {
    test: RegExp
    message: string
    severity: ErrorSeverity
    recoverySteps: string[]
}

const ERROR_RULES: ErrorRule[] = [
    {
        test: /\b500\b/i,
        message: '⚠️ Anthropic 服务器内部错误 (500)，请稍后重试',
        severity: 'transient',
        recoverySteps: ['等待 1-2 分钟后重试', '如果持续出现，检查 status.anthropic.com'],
    },
    {
        test: /\b529\b|overloaded/i,
        message: '⚠️ Anthropic API 过载 (529)，请稍后重试',
        severity: 'transient',
        recoverySteps: ['等待 1-2 分钟后重试', '高峰期可尝试切换到较小模型'],
    },
    {
        test: /\b429\b|rate.?limit/i,
        message: '⚠️ 请求频率超限，请等待后重试',
        severity: 'quota',
        recoverySteps: ['等待限额重置后重试', '使用 !usage 查看当前用量', '使用 !auth 切换到其他账户'],
    },
    {
        test: /\b401\b|unauthorized|authentication/i,
        message: '⚠️ API 认证失败，请检查账户配置',
        severity: 'auth',
        recoverySteps: ['使用 !auth 检查当前账户', '使用 !login 重新登录'],
    },
    {
        test: /\b403\b|forbidden|permission.?denied/i,
        message: '⚠️ API 权限不足',
        severity: 'auth',
        recoverySteps: ['使用 !auth 检查当前账户', '确认账户订阅状态是否有效'],
    },
    {
        test: /timeout|ETIMEDOUT|ECONNREFUSED|ECONNRESET/i,
        message: '⚠️ 连接超时或被拒绝，请检查网络',
        severity: 'transient',
        recoverySteps: ['检查网络连接', '如果使用代理，确认代理配置正确', '等待几秒后重试'],
    },
    {
        test: /ENOENT/i,
        message: '⚠️ 文件或路径不存在',
        severity: 'permanent',
        recoverySteps: [],
    },
    {
        test: /error_max_turns/i,
        message: '⚠️ 达到最大轮次限制',
        severity: 'permanent',
        recoverySteps: ['发送新消息继续对话'],
    },
]

/** Structured error type → severity + recovery steps mapping. */
const STRUCTURED_ERROR_MAP: Record<string, { severity: ErrorSeverity; recoverySteps: string[] }> = {
    'api_error':            { severity: 'transient', recoverySteps: ['等待 1-2 分钟后重试', '如果持续出现，检查 status.anthropic.com'] },
    'overloaded_error':     { severity: 'transient', recoverySteps: ['等待 1-2 分钟后重试', '高峰期可尝试切换到较小模型'] },
    'rate_limit_error':     { severity: 'quota',     recoverySteps: ['等待限额重置后重试', '使用 !usage 查看当前用量', '使用 !auth 切换到其他账户'] },
    'authentication_error': { severity: 'auth',      recoverySteps: ['使用 !auth 检查当前账户', '使用 !login 重新登录'] },
    'permission_error':     { severity: 'auth',      recoverySteps: ['使用 !auth 检查当前账户', '确认账户订阅状态是否有效'] },
    'invalid_request_error': { severity: 'permanent', recoverySteps: [] },
    'not_found_error':      { severity: 'permanent', recoverySteps: [] },
}

/**
 * Try to parse Anthropic-style structured error from the raw message.
 * Handles format: `API Error: {statusCode} {json}`
 * where json is `{"type":"error","error":{"type":"...","message":"..."}}`
 */
function tryParseStructuredError(raw: string): ErrorFormatResult | null {
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

        const display = typeMap[errorType] ?? `⚠️ API 错误 (${statusCode}): ${errorMessage || errorType}`
        const meta = STRUCTURED_ERROR_MAP[errorType] ?? { severity: 'permanent' as ErrorSeverity, recoverySteps: [] }

        return { display, raw, severity: meta.severity, recoverySteps: meta.recoverySteps }
    } catch {
        // JSON parse failed, return null to fall through to regex
        return null
    }
}

/**
 * Sanitize raw error message into user-friendly text with severity and recovery steps.
 *
 * 1. Try structured JSON parsing (for Anthropic API errors)
 * 2. Fall back to regex pattern matching
 * 3. Default: truncate to 200 chars, severity = permanent
 */
export function formatErrorForUser(rawMessage: string): ErrorFormatResult {
    const raw = rawMessage

    // Step 1: try structured parsing
    const structured = tryParseStructuredError(raw)
    if (structured) {
        return structured
    }

    // Step 2: regex pattern matching
    for (const rule of ERROR_RULES) {
        if (rule.test.test(raw)) {
            return { display: rule.message, raw, severity: rule.severity, recoverySteps: rule.recoverySteps }
        }
    }

    // Step 3: fallback — strip obvious JSON blobs and truncate
    const cleaned = raw.replace(/\{[^}]{50,}\}/g, '[...]').trim()
    const display = cleaned.length > 200 ? cleaned.slice(0, 200) + '...' : cleaned
    return { display, raw, severity: 'permanent', recoverySteps: [] }
}
