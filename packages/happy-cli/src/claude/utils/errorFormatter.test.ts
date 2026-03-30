import { describe, it, expect } from 'vitest'
import { formatErrorForUser } from './errorFormatter'
import type { ErrorSeverity } from './errorFormatter'

describe('formatErrorForUser', () => {
    describe('structured JSON parsing (Anthropic API errors)', () => {
        it('should parse api_error with 500', () => {
            const raw = 'API Error: 500 {"type":"error","error":{"type":"api_error","message":"Internal server error"},"request_id":"req_011CZTCHWeLHaHKaXinXdsET"}'
            const { display, raw: returned, severity } = formatErrorForUser(raw)
            expect(display).toBe('⚠️ Anthropic 服务器错误 (500)，请稍后重试')
            expect(returned).toBe(raw)
            expect(severity).toBe('transient')
        })

        it('should parse overloaded_error', () => {
            const raw = 'API Error: 529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}'
            const { display, severity } = formatErrorForUser(raw)
            expect(display).toBe('⚠️ Anthropic API 过载 (529)，请稍后重试')
            expect(severity).toBe('transient')
        })

        it('should parse rate_limit_error', () => {
            const raw = 'API Error: 429 {"type":"error","error":{"type":"rate_limit_error","message":"Rate limited"}}'
            const { display, severity, recoverySteps } = formatErrorForUser(raw)
            expect(display).toBe('⚠️ 请求频率超限 (429)，请等待后重试')
            expect(severity).toBe('quota')
            expect(recoverySteps).toContain('使用 !usage 查看当前用量')
            expect(recoverySteps).toContain('使用 !auth 切换到其他账户')
        })

        it('should parse authentication_error', () => {
            const raw = 'API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"Invalid API key"}}'
            const { display, severity, recoverySteps } = formatErrorForUser(raw)
            expect(display).toBe('⚠️ API 认证失败 (401)，请检查账户配置')
            expect(severity).toBe('auth')
            expect(recoverySteps).toContain('使用 !login 重新登录')
        })

        it('should parse invalid_request_error with message', () => {
            const raw = 'API Error: 400 {"type":"error","error":{"type":"invalid_request_error","message":"max_tokens must be positive"}}'
            const { display, severity } = formatErrorForUser(raw)
            expect(display).toContain('请求参数错误 (400)')
            expect(display).toContain('max_tokens must be positive')
            expect(severity).toBe('permanent')
        })

        it('should handle unknown error type with message', () => {
            const raw = 'API Error: 503 {"type":"error","error":{"type":"new_error_type","message":"Something new"}}'
            const { display, severity } = formatErrorForUser(raw)
            expect(display).toContain('503')
            expect(display).toContain('Something new')
            expect(severity).toBe('permanent')
        })
    })

    describe('regex fallback', () => {
        it('should match 500 without JSON', () => {
            const { display, severity } = formatErrorForUser('Error 500 from upstream')
            expect(display).toContain('500')
            expect(severity).toBe('transient')
        })

        it('should match timeout errors', () => {
            const { display, severity } = formatErrorForUser('Error: connect ETIMEDOUT 1.2.3.4:443')
            expect(display).toContain('连接超时')
            expect(severity).toBe('transient')
        })

        it('should match ENOENT', () => {
            const { display, severity } = formatErrorForUser("Error: ENOENT: no such file or directory, open '/foo/bar'")
            expect(display).toContain('文件或路径不存在')
            expect(severity).toBe('permanent')
        })

        it('should match error_max_turns', () => {
            const { display, severity } = formatErrorForUser('error_max_turns: reached maximum number of turns')
            expect(display).toContain('最大轮次限制')
            expect(severity).toBe('permanent')
        })
    })

    describe('severity classification', () => {
        const cases: Array<[string, ErrorSeverity]> = [
            ['API Error: 500 {"type":"error","error":{"type":"api_error","message":"err"}}', 'transient'],
            ['API Error: 529 {"type":"error","error":{"type":"overloaded_error","message":"err"}}', 'transient'],
            ['API Error: 429 {"type":"error","error":{"type":"rate_limit_error","message":"err"}}', 'quota'],
            ['API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"err"}}', 'auth'],
            ['API Error: 403 {"type":"error","error":{"type":"permission_error","message":"err"}}', 'auth'],
            ['API Error: 400 {"type":"error","error":{"type":"invalid_request_error","message":"err"}}', 'permanent'],
            ['Error: connect ETIMEDOUT 1.2.3.4:443', 'transient'],
            ['Error 429 rate limit exceeded', 'quota'],
            ['Error 401 unauthorized', 'auth'],
            ['error_max_turns: reached max', 'permanent'],
            ['Something completely unknown', 'permanent'],
        ]

        for (const [input, expected] of cases) {
            it(`should classify "${input.slice(0, 50)}..." as ${expected}`, () => {
                expect(formatErrorForUser(input).severity).toBe(expected)
            })
        }
    })

    describe('recovery steps', () => {
        it('should include usage and auth steps for rate limit errors', () => {
            const raw = 'API Error: 429 {"type":"error","error":{"type":"rate_limit_error","message":"err"}}'
            const { recoverySteps } = formatErrorForUser(raw)
            expect(recoverySteps.length).toBeGreaterThan(0)
            expect(recoverySteps.some(s => s.includes('!usage'))).toBe(true)
            expect(recoverySteps.some(s => s.includes('!auth'))).toBe(true)
        })

        it('should include login step for auth errors', () => {
            const raw = 'API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"err"}}'
            const { recoverySteps } = formatErrorForUser(raw)
            expect(recoverySteps.some(s => s.includes('!login'))).toBe(true)
        })

        it('should include retry guidance for transient errors', () => {
            const raw = 'API Error: 500 {"type":"error","error":{"type":"api_error","message":"err"}}'
            const { recoverySteps } = formatErrorForUser(raw)
            expect(recoverySteps.some(s => s.includes('重试'))).toBe(true)
        })

        it('should return empty steps for unknown errors', () => {
            const { recoverySteps } = formatErrorForUser('Something went wrong')
            expect(recoverySteps).toEqual([])
        })

        it('should return empty steps for permanent errors', () => {
            const { recoverySteps } = formatErrorForUser("Error: ENOENT: no such file or directory, open '/foo/bar'")
            expect(recoverySteps).toEqual([])
        })
    })

    describe('fallback truncation', () => {
        it('should pass through short non-error messages', () => {
            const { display } = formatErrorForUser('Something went wrong')
            expect(display).toBe('Something went wrong')
        })

        it('should truncate long messages to 200 chars', () => {
            const long = 'x'.repeat(300)
            const { display } = formatErrorForUser(long)
            expect(display.length).toBeLessThanOrEqual(203) // 200 + '...'
        })

        it('should strip large JSON blobs in fallback', () => {
            const raw = 'Error happened: {"very_long_key":"' + 'a'.repeat(100) + '"} and more'
            const { display } = formatErrorForUser(raw)
            expect(display).not.toContain('very_long_key')
            expect(display).toContain('[...]')
        })
    })

    describe('raw field preservation', () => {
        it('should always return original input as raw', () => {
            const inputs = [
                'API Error: 500 {"type":"error","error":{"type":"api_error","message":"Internal server error"}}',
                'Error: ENOENT',
                'normal message',
            ]
            for (const input of inputs) {
                expect(formatErrorForUser(input).raw).toBe(input)
            }
        })
    })
})
