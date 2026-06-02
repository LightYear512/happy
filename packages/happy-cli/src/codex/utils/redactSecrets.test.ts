import { describe, it, expect } from 'vitest';
import { redactSensitive, redactHighConfidenceSecrets } from './redactSecrets';

/**
 * Guards the redaction logic extracted from compactSeedBuilder into this shared
 * leaf module. The `redactSensitive` block is the *regression anchor*: its
 * behaviour must stay byte-for-byte identical to the pre-extraction inline
 * version, since compactSeedBuilder still relies on it for every user/assistant
 * turn that enters the seed.
 */
describe('redactSecrets', () => {
    describe('redactSensitive — full set (regression anchor for the inline version)', () => {
        it('redacts OpenAI / Anthropic style keys', () => {
            expect(redactSensitive('sk-' + 'a'.repeat(24))).toBe('[REDACTED-API-KEY]');
            expect(redactSensitive('use key=sk-ant-abcdefghijklmnopqrstuvwxyz0123 here')).toContain('[REDACTED-API-KEY]');
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
