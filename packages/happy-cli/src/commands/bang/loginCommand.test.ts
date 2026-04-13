import { describe, it, expect } from 'vitest';
import { analyzePtyOutput, analyzeCodexPtyOutput, stripAnsiOnly, parseLoginArgs, type PtyAction } from './loginCommand';

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

        it('detects "Welcome back" as already-authenticated', () => {
            const buffer = 'Claude Code v2.1.87\nTips for getting started\nWelcome back!  Run /init to create a CLAUDE.md';
            const result = analyzePtyOutput(buffer, PRE_LOGIN, false);
            expect(result).toEqual({ action: 'already-authenticated' });
        });

        it('detects "Welcome back" with ANSI sequences', () => {
            const buffer = '\x1B[1mClaude Code v2.1.87\x1B[0m\n\x1B[32mWelcome back\x1B[0m! Run /init';
            const result = analyzePtyOutput(buffer, PRE_LOGIN, false);
            expect(result).toEqual({ action: 'already-authenticated' });
        });

        it('does not detect "Welcome back" after /login already sent', () => {
            const buffer = 'Claude Code v2.1.87\nWelcome back! Run /init';
            const result = analyzePtyOutput(buffer, false, true);
            // loginCommandSent=true → skip "Welcome back" to avoid loop after forced /login
            expect(result).toEqual({ action: 'discard' });
        });

        it('does not detect "Welcome back" after login URL sent (phase 2)', () => {
            const buffer = 'Welcome back! Login successful';
            const result = analyzePtyOutput(buffer, true, true);
            // In phase 2 (loginUrlSent=true), always returns 'forward'
            expect(result).toEqual({ action: 'forward' });
        });

        it('prioritizes OAuth URL over "Welcome back"', () => {
            const buffer = 'Welcome back\nhttps://claude.ai/oauth/authorize?code=true\n';
            const result = analyzePtyOutput(buffer, PRE_LOGIN, false);
            expect(result.action).toBe('forward-url');
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

describe('analyzeCodexPtyOutput', () => {
    // Real capture from `codex login --device-auth` (codex-cli 0.118.0), see
    // packages/happy-cli/src/commands/bang/loginCommand.ts for JSDoc on the flow.
    const REAL_DEVICE_AUTH_BUFFER =
        '\u001b[?9001h\u001b[?1004h\u001b[?25l\u001b[2J\u001b[m\u001b[H\u001b]0;cmd.exe\u0007\u001b[?25h\r\n'
        + '\u001b[?25lWelcome to Codex [v\u001b[90m0.118.0\u001b[m]\u001b[90m\r\n'
        + 'OpenAI\'s command-line coding agent\u001b[m'
        + '\u001b[5;1HFollow these steps to sign in with ChatGPT using device code authorization:'
        + '\u001b[7;1H1. Open this link in your browser and sign in to your account\r\n'
        + '   \u001b[94mhttps://auth.openai.com/codex/device\u001b[m'
        + '\u001b[10;1H2. Enter this one-time code \u001b[90m(expires in 15 minutes)\u001b[m\r\n'
        + '   \u001b[94mEZVG-FFQFL\u001b[90m'
        + '\u001b[13;1HDevice codes are a common phishing target. Never share this code.'
        + '\u001b[15;1H\u001b[?25h\u001b[?9001l\u001b[?1004l\u001b[m';

    describe('device-auth flow', () => {
        it('extracts both URL and one-time code from real device-auth output', () => {
            const result = analyzeCodexPtyOutput(REAL_DEVICE_AUTH_BUFFER);
            expect(result.action).toBe('forward-url');
            if (result.action !== 'forward-url') return;
            expect(result.url).toBe('https://auth.openai.com/codex/device');
            expect(result.code).toBe('EZVG-FFQFL');
        });

        it('waits (discard) when URL rendered but code not yet flushed', () => {
            const partial =
                'Follow these steps to sign in with ChatGPT using device code authorization:\n'
                + '1. Open this link in your browser and sign in to your account\n'
                + '   https://auth.openai.com/codex/device\n'
                + '2. Enter this one-time code (expires in 15 minutes)\n'
                + '   '; // code chunk hasn't arrived yet
            expect(analyzeCodexPtyOutput(partial)).toEqual({ action: 'discard' });
        });

        it('extracts code with 4-4 pattern as well as 4-5', () => {
            const buf =
                'Enter this one-time code\n'
                + 'https://auth.openai.com/codex/device\n'
                + 'ABCD-1234\n';
            const result = analyzeCodexPtyOutput(buf);
            expect(result.action).toBe('forward-url');
            if (result.action !== 'forward-url') return;
            expect(result.code).toBe('ABCD-1234');
        });

        it('does not treat arbitrary uppercase tokens as codes in legacy flow', () => {
            // Legacy (non-device) flow: URL without any "one-time code" / "/device" marker.
            // Any random TOKEN-LIKE string in adjacent UI chrome must NOT be harvested as a code.
            const buf = 'Open https://auth.openai.com/oauth/authorize?x=1 to continue\nABCD-12345 unrelated';
            const result = analyzeCodexPtyOutput(buf);
            expect(result.action).toBe('forward-url');
            if (result.action !== 'forward-url') return;
            expect(result.code).toBeUndefined();
        });
    });

    describe('success / error / discard', () => {
        it('detects "Logged in" as success', () => {
            expect(analyzeCodexPtyOutput('Successfully logged in!\n')).toEqual({ action: 'success' });
        });

        it('detects config load error', () => {
            const result = analyzeCodexPtyOutput('Error loading configuration from ~/.codex/config.toml');
            expect(result.action).toBe('error');
        });

        it('discards incomplete output', () => {
            expect(analyzeCodexPtyOutput('Welcome to Codex\n')).toEqual({ action: 'discard' });
        });
    });
});

describe('parseLoginArgs', () => {
    describe('no-args branch', () => {
        it('empty args → claude list', () => {
            expect(parseLoginArgs('', 'claude')).toEqual({
                kind: 'ok',
                profileName: undefined,
                targetAgent: 'claude',
                contextMode: 'shared',
            });
        });

        it('empty args with codex flavor → codex list', () => {
            const r = parseLoginArgs('', 'codex');
            expect(r).toMatchObject({ kind: 'ok', profileName: undefined, targetAgent: 'codex' });
        });

        it('--codex alone → codex list (flag-only)', () => {
            const r = parseLoginArgs('--codex', 'claude');
            expect(r).toMatchObject({ kind: 'ok', profileName: undefined, targetAgent: 'codex' });
        });

        it('gemini flavor → falls back to claude', () => {
            const r = parseLoginArgs('', 'gemini');
            expect(r).toMatchObject({ kind: 'ok', targetAgent: 'claude' });
        });

        it('undefined flavor → falls back to claude', () => {
            const r = parseLoginArgs('', undefined);
            expect(r).toMatchObject({ kind: 'ok', targetAgent: 'claude' });
        });
    });

    describe('positional + flag combinations', () => {
        it('name only → claude, shared', () => {
            expect(parseLoginArgs('abc', 'claude')).toEqual({
                kind: 'ok',
                profileName: 'abc',
                targetAgent: 'claude',
                contextMode: 'shared',
            });
        });

        it('name --codex (flag after) → codex', () => {
            expect(parseLoginArgs('abc --codex', 'claude')).toMatchObject({
                kind: 'ok', profileName: 'abc', targetAgent: 'codex',
            });
        });

        it('--codex name (flag before) → codex, same result', () => {
            expect(parseLoginArgs('--codex abc', 'claude')).toMatchObject({
                kind: 'ok', profileName: 'abc', targetAgent: 'codex',
            });
        });

        it('name --isolated → isolated mode', () => {
            expect(parseLoginArgs('abc --isolated', 'claude')).toEqual({
                kind: 'ok',
                profileName: 'abc',
                targetAgent: 'claude',
                contextMode: 'isolated',
            });
        });

        it('explicit --codex overrides codex flavor session', () => {
            expect(parseLoginArgs('abc --codex', 'codex')).toMatchObject({ targetAgent: 'codex' });
        });

        it('codex flavor session without --codex flag still picks codex', () => {
            expect(parseLoginArgs('abc', 'codex')).toMatchObject({ targetAgent: 'codex' });
        });
    });

    describe('validation errors', () => {
        it('invalid profileName → error', () => {
            expect(parseLoginArgs('bad!name', 'claude')).toEqual({
                kind: 'error',
                message: expect.stringContaining('无效的配置名称'),
            });
        });

        it('profileName starting with digit → error', () => {
            expect(parseLoginArgs('1abc', 'claude')).toMatchObject({ kind: 'error' });
        });
    });

    describe('edge cases', () => {
        it('unknown flag --foo is silently ignored, positional still wins', () => {
            expect(parseLoginArgs('--foo abc', 'claude')).toMatchObject({
                kind: 'ok', profileName: 'abc', targetAgent: 'claude',
            });
        });

        it('tolerates extra whitespace', () => {
            expect(parseLoginArgs('   abc   --codex   ', 'claude')).toMatchObject({
                kind: 'ok', profileName: 'abc', targetAgent: 'codex',
            });
        });

        it('duplicate profileName tokens → first wins silently', () => {
            expect(parseLoginArgs('first second', 'claude')).toMatchObject({
                kind: 'ok', profileName: 'first',
            });
        });
    });
});
