import { describe, it, expect } from 'vitest';
import { redactSensitive, redactHighConfidenceSecrets } from './redactSecrets';

/**
 * Shared credential redaction, including startup errors. High-confidence-only
 * project documentation handling must retain its distinct, narrower policy.
 */
describe('redactSecrets', () => {
    describe('redactSensitive — full set', () => {
        it('redacts OpenAI / Anthropic style keys', () => {
            expect(redactSensitive('sk-' + 'a'.repeat(24))).toBe('[REDACTED-API-KEY]');
            expect(redactSensitive('use key=sk-ant-' + 'DUMMY_'.repeat(6) + ' here')).toContain('[REDACTED-API-KEY]');
        });

        it('redacts GitHub PATs', () => {
            expect(redactSensitive('ghp_' + 'a'.repeat(36))).toBe('[REDACTED-GH-PAT]');
            expect(redactSensitive('github_pat_' + 'a'.repeat(60))).toContain('[REDACTED-GH-PAT]');
        });

        it('redacts Slack / AWS / JWT tokens', () => {
            expect(redactSensitive('xoxb-' + '1'.repeat(20))).toBe('[REDACTED-SLACK]');
            expect(redactSensitive('AKIA' + 'ABCDEFGHIJKLMNOP')).toBe('[REDACTED-AWS]');
            const jwt = 'eyJ' + 'a'.repeat(12) + '.' + 'b'.repeat(12) + '.' + 'c'.repeat(12);
            expect(redactSensitive(jwt)).toBe('[REDACTED-JWT]');
        });

        it('redacts Authorization headers and name=value secrets (preserving the name)', () => {
            expect(redactSensitive('Authorization: Bearer abc.def.ghi')).toBe('Authorization: [REDACTED]');
            expect(redactSensitive('password=supersecret123')).toBe('password=[REDACTED]');
            expect(redactSensitive('api_key: "abcd1234efgh"')).toContain('[REDACTED]');
        });

        it('leaves ordinary text and empty input untouched', () => {
            expect(redactSensitive('')).toBe('');
            expect(redactSensitive('a normal sentence touching files.ts and foo.py')).toBe('a normal sentence touching files.ts and foo.py');
        });

        it('redacts quoted Authorization fields including spaces, escapes and partial values', () => {
            for (const field of ['Authorization', 'authorization', 'AUTHORIZATION', 'Proxy-Authorization']) {
                for (const scheme of ['Bearer', 'Basic', 'Token']) {
                    const input = JSON.stringify({ [field]: `${scheme} private value \\" suffix`, status: 'failed' });
                    expect(redactSensitive(input)).toBe(`{"${field}":[REDACTED],"status":"failed"}`);
                }
            }
            expect(redactSensitive("'Authorization': 'Bearer private value'"))
                .toBe("'Authorization': [REDACTED]");
            expect(redactSensitive('Authorization: "Bearer unfinished private value'))
                .toBe('Authorization: [REDACTED]');
            expect(redactSensitive('"Authorization": Bearer private-value'))
                .toBe('"Authorization": [REDACTED]');
        });

        it('redacts short and punctuation-bearing credential values', () => {
            expect(redactSensitive('password=P@ssw0rd!')).toBe('password=[REDACTED]');
            expect(redactSensitive('passwd=a')).toBe('passwd=[REDACTED]');
            expect(redactSensitive('secret="two words, !@#$"')).toBe('secret=[REDACTED]');
            expect(redactSensitive("password='with spaces and punctuation!'")).toBe('password=[REDACTED]');
        });

        it('redacts OAuth fields and environment-prefixed credentials', () => {
            for (const field of ['refresh_token', 'id_token', 'token', 'OPENAI_API_KEY', 'MY_CLIENT_SECRET']) {
                expect(redactSensitive(`${field}=review-credential`)).toBe(`${field}=[REDACTED]`);
            }
            expect(redactSensitive('{"refresh_token":"private value", "status":"failed"}'))
                .toBe('{"refresh_token":[REDACTED], "status":"failed"}');
        });

        it('handles quoted escapes and incomplete quoted values without leaking their suffix', () => {
            expect(redactSensitive(String.raw`password="escaped\" quote and space"`))
                .toBe('password=[REDACTED]');
            expect(redactSensitive('password="unfinished private value')).toBe('password=[REDACTED]');
            expect(redactSensitive('api_key=sk-' + 'a'.repeat(32))).toBe('api_key=[REDACTED-API-KEY]');
        });

        it('never treats a redaction marker inside a larger credential as an already safe value', () => {
            for (const value of ['[REDACTED]private', 'a,b;c}d]e!', '"[REDACTED] private suffix"', '"private value\\']) {
                expect(redactSensitive(`password=${value}`)).toBe('password=[REDACTED]');
            }
        });
    });

    describe('redactHighConfidenceSecrets — subset for the project doc', () => {
        it('still redacts distinctive-prefix keys', () => {
            expect(redactHighConfidenceSecrets('sk-' + 'a'.repeat(24))).toBe('[REDACTED-API-KEY]');
            expect(redactHighConfidenceSecrets('ghp_' + 'a'.repeat(36))).toBe('[REDACTED-GH-PAT]');
            expect(redactHighConfidenceSecrets('AKIA' + 'ABCDEFGHIJKLMNOP')).toBe('[REDACTED-AWS]');
        });

        it('does NOT touch generalized name=value or Authorization (avoids clobbering doc examples)', () => {
            // A doc *explaining* "set password=your_value_here" must survive intact.
            expect(redactHighConfidenceSecrets('password=your_value_here')).toBe('password=your_value_here');
            expect(redactHighConfidenceSecrets('Authorization: Bearer placeholder')).toBe('Authorization: Bearer placeholder');
        });
    });
});
