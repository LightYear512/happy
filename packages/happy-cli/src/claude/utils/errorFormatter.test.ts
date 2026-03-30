import { describe, it, expect } from 'vitest'
import { formatErrorForUser } from './errorFormatter'

describe('formatErrorForUser', () => {
    describe('structured JSON parsing (Anthropic API errors)', () => {
        it('should parse api_error with 500', () => {
            const raw = 'API Error: 500 {"type":"error","error":{"type":"api_error","message":"Internal server error"},"request_id":"req_011CZTCHWeLHaHKaXinXdsET"}'
            const { display, raw: returned } = formatErrorForUser(raw)
            expect(display).toBe('⚠️ Anthropic 服务器错误 (500)，请稍后重试')
            expect(returned).toBe(raw)
        })

        it('should parse overloaded_error', () => {
            const raw = 'API Error: 529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}'
            const { display } = formatErrorForUser(raw)
            expect(display).toBe('⚠️ Anthropic API 过载 (529)，请稍后重试')
        })

        it('should parse rate_limit_error', () => {
            const raw = 'API Error: 429 {"type":"error","error":{"type":"rate_limit_error","message":"Rate limited"}}'
            const { display } = formatErrorForUser(raw)
            expect(display).toBe('⚠️ 请求频率超限 (429)，请等待后重试')
        })

        it('should parse authentication_error', () => {
            const raw = 'API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"Invalid API key"}}'
            const { display } = formatErrorForUser(raw)
            expect(display).toBe('⚠️ API 认证失败 (401)，请检查账户配置')
        })

        it('should parse invalid_request_error with message', () => {
            const raw = 'API Error: 400 {"type":"error","error":{"type":"invalid_request_error","message":"max_tokens must be positive"}}'
            const { display } = formatErrorForUser(raw)
            expect(display).toContain('请求参数错误 (400)')
            expect(display).toContain('max_tokens must be positive')
        })

        it('should handle unknown error type with message', () => {
            const raw = 'API Error: 503 {"type":"error","error":{"type":"new_error_type","message":"Something new"}}'
            const { display } = formatErrorForUser(raw)
            expect(display).toContain('503')
            expect(display).toContain('Something new')
        })
    })

    describe('regex fallback', () => {
        it('should match 500 without JSON', () => {
            const { display } = formatErrorForUser('Error 500 from upstream')
            expect(display).toContain('500')
        })

        it('should match timeout errors', () => {
            const { display } = formatErrorForUser('Error: connect ETIMEDOUT 1.2.3.4:443')
            expect(display).toContain('连接超时')
        })

        it('should match ENOENT', () => {
            const { display } = formatErrorForUser("Error: ENOENT: no such file or directory, open '/foo/bar'")
            expect(display).toContain('文件或路径不存在')
        })

        it('should match error_max_turns', () => {
            const { display } = formatErrorForUser('error_max_turns: reached maximum number of turns')
            expect(display).toContain('最大轮次限制')
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
