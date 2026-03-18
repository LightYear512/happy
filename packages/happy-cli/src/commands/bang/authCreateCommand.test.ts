import { describe, it, expect } from 'vitest';
import { analyzePtyOutput, stripAnsiOnly, type PtyAction } from './authCreateCommand';

// Real OAuth URL from actual Claude Code login flow
const REAL_OAUTH_URL = 'https://claude.ai/oauth/authorize?code=true&client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e&response_type=code&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&scope=org%3Acreate_api_key+user%3Aprofile+user%3Ainference+user%3Asessions%3Aclaude_code+user%3Amcp_servers+user%3Afile_upload&code_challenge=9wvqXasXp7FespyUXZRRUy7pzFl6NfFQR0bO-vCLBr4&code_challenge_method=S256&state=2ppMXLEutGbkjDlq3aZdYUJqF3-sU7RUX1xODTviPkE';

/**
 * Simulate PTY line wrapping: insert cursor positioning sequences
 * every `cols` characters within the URL, like a real terminal would.
 */
function simulatePtyWrap(text: string, cols: number): string {
    let result = '';
    let col = 0;
    let row = 1;
    for (const ch of text) {
        if (col >= cols) {
            row++;
            result += `\x1B[${row};1H`;
            col = 0;
        }
        result += ch;
        col++;
    }
    return result;
}

describe('stripAnsiOnly', () => {
    it('removes ANSI sequences without adding whitespace', () => {
        const input = 'hello\x1B[1m world\x1B[0m\x1B[5;1Hfoo';
        expect(stripAnsiOnly(input)).toBe('hello worldfoo');
    });

    it('keeps URL intact across line-wrap positioning', () => {
        const wrapped = simulatePtyWrap(REAL_OAUTH_URL, 120);
        expect(stripAnsiOnly(wrapped)).toBe(REAL_OAUTH_URL);
    });
});

describe('analyzePtyOutput', () => {
    describe('phase 1 — before login URL sent', () => {
        const PRE_LOGIN = false;

        it('extracts complete real-world OAuth URL with PTY line wrapping at 120 cols', () => {
            // Simulate: URL wrapped at 120 cols + Claude UI text after
            const wrappedUrl = simulatePtyWrap(REAL_OAUTH_URL, 120);
            const buffer = '\x1B[1mOpen this URL:\x1B[0m\n' + wrappedUrl +
                '\x1B[20;1HPaste code here if prompted\x1B[21;1H> Esc to cancel';
            const result = analyzePtyOutput(buffer, PRE_LOGIN, false);
            expect(result.action).toBe('forward-url');
            expect((result as Extract<PtyAction, { action: 'forward-url' }>).url).toBe(REAL_OAUTH_URL);
        });

        it('extracts complete URL with PTY line wrapping at 80 cols', () => {
            const wrappedUrl = simulatePtyWrap(REAL_OAUTH_URL, 80);
            const buffer = wrappedUrl + '\x1B[25;1HPaste code here';
            const result = analyzePtyOutput(buffer, PRE_LOGIN, false);
            expect(result.action).toBe('forward-url');
            expect((result as Extract<PtyAction, { action: 'forward-url' }>).url).toBe(REAL_OAUTH_URL);
        });

        it('strips "Pastecodehereifprompted" concatenated after URL (no positioning)', () => {
            const buffer = REAL_OAUTH_URL + 'Pastecodehereifprompted>Esctocancel';
            const result = analyzePtyOutput(buffer, PRE_LOGIN, false);
            expect(result.action).toBe('forward-url');
            expect((result as Extract<PtyAction, { action: 'forward-url' }>).url).toBe(REAL_OAUTH_URL);
        });

        it('extracts URL from clean text with newlines', () => {
            const buffer = 'Open this URL:\n' + REAL_OAUTH_URL + '\nThen paste the code';
            const result = analyzePtyOutput(buffer, PRE_LOGIN, false);
            expect(result.action).toBe('forward-url');
            expect((result as Extract<PtyAction, { action: 'forward-url' }>).url).toBe(REAL_OAUTH_URL);
        });

        it('extracts URL with ANSI style codes interleaved', () => {
            const buffer = 'Go to: https://claude.\x1B[0mai/\x1B[1moauth/authorize?code=true&client_id=abc&state=xyz\x1B[0m\n';
            const result = analyzePtyOutput(buffer, PRE_LOGIN, false);
            expect(result.action).toBe('forward-url');
            expect((result as Extract<PtyAction, { action: 'forward-url' }>).url)
                .toBe('https://claude.ai/oauth/authorize?code=true&client_id=abc&state=xyz');
        });

        it('ignores documentation URLs (not OAuth)', () => {
            const buffer = 'See https://docs.anthropic.com/security-guide for details\n';
            const result = analyzePtyOutput(buffer, PRE_LOGIN, false);
            expect(result).toEqual({ action: 'discard' });
        });

        it('detects "Not logged in" and responds with /login', () => {
            const buffer = '\x1B[31mNot logged in\x1B[0m. Run /login to authenticate.';
            const result = analyzePtyOutput(buffer, PRE_LOGIN, false);
            expect(result).toEqual({ action: 'auto-respond', response: '/login\r' });
        });

        it('does not send /login again after already sent (prevents loop)', () => {
            const buffer = 'Not logged in. Run /login';
            const result = analyzePtyOutput(buffer, PRE_LOGIN, true);
            expect(result).toEqual({ action: 'discard' });
        });

        it('detects "Select login method" with proper whitespace', () => {
            const buffer = '\x1B[1mSelect login method:\x1B[0m\n\x1B[32m❯\x1B[0m 1. Claude account\n  2. Anthropic Console\n';
            const result = analyzePtyOutput(buffer, PRE_LOGIN, false);
            expect(result).toEqual({ action: 'auto-respond', response: '\r' });
        });

        it('detects workspace trust prompt', () => {
            const buffer = '\x1B[?25l' +
                'Accessing workspace: C:/Users/xuhao\x1B[3;1H' +
                'Quick safety check\x1B[4;1H' +
                '1. Yes, I trust this folder\x1B[5;1H' +
                '2. No, exit\x1B[?25h';
            const result = analyzePtyOutput(buffer, PRE_LOGIN, false);
            expect(result).toEqual({ action: 'auto-respond', response: '\r' });
        });

        it('detects onboarding theme selector', () => {
            const buffer = '\x1B[?25l Choose the text style\x1B[0m\n1. Dark mode\n2. Light mode\n';
            const result = analyzePtyOutput(buffer, PRE_LOGIN, false);
            expect(result).toEqual({ action: 'auto-respond', response: '\r' });
        });

        it('discards incomplete output', () => {
            expect(analyzePtyOutput('Loading Claude Code...', PRE_LOGIN, false)).toEqual({ action: 'discard' });
            expect(analyzePtyOutput('', PRE_LOGIN, false)).toEqual({ action: 'discard' });
        });

        it('prioritizes OAuth URL over other patterns', () => {
            const buffer = 'Not logged in\nhttps://claude.ai/oauth/authorize?code=true\n';
            const result = analyzePtyOutput(buffer, PRE_LOGIN, false);
            expect(result.action).toBe('forward-url');
        });
    });

    describe('phase 2 — after login URL sent', () => {
        it('forwards all output', () => {
            expect(analyzePtyOutput('Login successful!', true, true)).toEqual({ action: 'forward' });
            expect(analyzePtyOutput('1. Option\n2. Option\n', true, true)).toEqual({ action: 'forward' });
        });
    });
});
