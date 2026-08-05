import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { analyzePtyOutput, analyzeCodexPtyOutput, stripAnsiOnly, parseLoginArgs, recoverInterruptedCodexLogin, acquireCodexLoginLock, updateCodexLoginLockToSpawned, createClaudeLoginPreAuthDeadline, shouldAcceptClaudeLoginResult, type PtyAction } from './loginCommand';

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

        it('detects an authenticated Claude main prompt without Welcome back', () => {
            const buffer = '\x1B[1mClaude Code v2.1.170\x1B[0m\n'
                + 'Account\n'
                + '❯\u00A0Try "explain this project"\n'
                + '? for shortcuts';
            const result = analyzePtyOutput(buffer, PRE_LOGIN, false);
            expect(result).toEqual({ action: 'already-authenticated' });
        });

        it('does not classify partial Claude main-screen markers as authenticated', () => {
            const versionOnly = 'Claude Code v2.1.170\nAccount';
            const promptOnly = 'Account\n❯\u00A0Try "explain this project"\n? for shortcuts';
            const alreadySent = 'Claude Code v2.1.170\nAccount\n'
                + '❯\u00A0Try "explain this project"\n? for shortcuts';

            expect(analyzePtyOutput(versionOnly, PRE_LOGIN, false)).toEqual({ action: 'discard' });
            expect(analyzePtyOutput(promptOnly, PRE_LOGIN, false)).toEqual({ action: 'discard' });
            expect(analyzePtyOutput(alreadySent, PRE_LOGIN, true)).toEqual({ action: 'discard' });
        });

        it('keeps the login method selector ahead of authenticated main-screen detection', () => {
            const buffer = 'Claude Code v2.1.170\nSelect login method:\n'
                + '❯ 1. Claude account\n  2. Anthropic Console\n? for shortcuts';
            const result = analyzePtyOutput(buffer, PRE_LOGIN, false);
            expect(result).toEqual({ action: 'auto-respond', response: '\r' });
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

describe('createClaudeLoginPreAuthDeadline', () => {
    it('fires a zero-delay pre-OAuth deadline exactly once', async () => {
        let deliveries = 0;
        const deadline = createClaudeLoginPreAuthDeadline(() => {
            deliveries++;
        }, 0);

        await new Promise(resolve => setTimeout(resolve, 20));
        deadline.clear();
        deadline.clear();

        expect(deliveries).toBe(1);
    });

    it('clearing after an OAuth URL prevents pre-OAuth timeout delivery', async () => {
        let deliveries = 0;
        const deadline = createClaudeLoginPreAuthDeadline(() => {
            deliveries++;
        }, 20);

        deadline.clear();
        deadline.clear();
        await new Promise(resolve => setTimeout(resolve, 40));

        expect(deliveries).toBe(0);
    });

    it('rejects unsafe pre-OAuth timeout budgets', () => {
        for (const timeoutMs of [-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, 2_147_483_648]) {
            expect(() => createClaudeLoginPreAuthDeadline(() => {}, timeoutMs)).toThrow(RangeError);
        }
    });
});

describe('shouldAcceptClaudeLoginResult', () => {
    it('accepts only explicit success or credentials created by this login attempt', () => {
        expect(shouldAcceptClaudeLoginResult({
            loginSucceeded: true,
            aborted: false,
            credentialExistedBefore: true,
            credentialExistsAfter: true,
        })).toBe(true);
        expect(shouldAcceptClaudeLoginResult({
            loginSucceeded: false,
            aborted: false,
            credentialExistedBefore: false,
            credentialExistsAfter: true,
        })).toBe(true);
        expect(shouldAcceptClaudeLoginResult({
            loginSucceeded: false,
            aborted: false,
            credentialExistedBefore: true,
            credentialExistsAfter: true,
        })).toBe(false);
    });

    it('rejects aborted Claude login results even when credentials exist', () => {
        expect(shouldAcceptClaudeLoginResult({
            loginSucceeded: true,
            aborted: true,
            credentialExistedBefore: false,
            credentialExistsAfter: true,
        })).toBe(false);
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
        it('name only → claude', () => {
            expect(parseLoginArgs('abc', 'claude')).toEqual({
                kind: 'ok',
                profileName: 'abc',
                targetAgent: 'claude',
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

describe('recoverInterruptedCodexLogin', () => {
    let tmpHome: string;

    beforeEach(() => {
        tmpHome = mkdtempSync(join(tmpdir(), 'happy-codex-recovery-'));
    });

    afterEach(() => {
        try { rmSync(tmpHome, { recursive: true, force: true }); } catch { /* best-effort */ }
    });

    const lockPath = (): string => join(tmpHome, '.happy-login.lock');
    const authPath = (): string => join(tmpHome, 'auth.json');
    const backupPath = (): string => join(tmpHome, 'auth.json.happy-bak');

    it('no lock file → no-op (idempotent on clean state)', () => {
        writeFileSync(authPath(), '{"original":true}');
        recoverInterruptedCodexLogin(tmpHome);
        expect(readFileSync(authPath(), 'utf-8')).toBe('{"original":true}');
        expect(existsSync(lockPath())).toBe(false);
        expect(existsSync(backupPath())).toBe(false);
    });

    it('stale lock + backup exists → restores backup, removes both lock and backup', () => {
        // Simulate: user had original auth.json, login created backup, then crashed
        writeFileSync(authPath(), '{"freshly_written_by_codex_login":true}');
        writeFileSync(backupPath(), '{"original_user_token":true}');
        writeFileSync(lockPath(), JSON.stringify({
            profileName: 'foo',
            pid: 999999, // dead pid
            backedUp: true,
            started: '2026-01-01T00:00:00Z',
        }));

        recoverInterruptedCodexLogin(tmpHome);

        expect(readFileSync(authPath(), 'utf-8')).toBe('{"original_user_token":true}');
        expect(existsSync(backupPath())).toBe(false);
        expect(existsSync(lockPath())).toBe(false);
    });

    it('stale lock + no backup + backedUp:false + auth.json present → removes leftover auth.json', () => {
        // Simulate: user had NO original auth.json, login wrote a fresh one, then crashed
        writeFileSync(authPath(), '{"freshly_written_by_codex_login":true}');
        writeFileSync(lockPath(), JSON.stringify({
            profileName: 'foo',
            pid: 999999, // dead pid
            backedUp: false,
        }));

        recoverInterruptedCodexLogin(tmpHome);

        // Original state was "no auth.json" — recovery must restore that, NOT leave the
        // freshly-written token in place (would silently bind ~/.codex to a happy account)
        expect(existsSync(authPath())).toBe(false);
        expect(existsSync(lockPath())).toBe(false);
    });

    it('lock held by LIVE pid → no-op (refuses to touch in-flight login)', () => {
        // Critical race-prevention test: a parallel happy CLI startup (e.g. daemon
        // --version) must NOT clobber a foreground login's state mid-flow.
        writeFileSync(authPath(), '{"in_flight_token":true}');
        writeFileSync(backupPath(), '{"would_be_restored_by_buggy_recovery":true}');
        writeFileSync(lockPath(), JSON.stringify({
            profileName: 'foo',
            pid: process.pid, // LIVE
            backedUp: true,
        }));

        recoverInterruptedCodexLogin(tmpHome);

        // Nothing should have changed
        expect(readFileSync(authPath(), 'utf-8')).toBe('{"in_flight_token":true}');
        expect(readFileSync(backupPath(), 'utf-8')).toBe('{"would_be_restored_by_buggy_recovery":true}');
        expect(existsSync(lockPath())).toBe(true);
    });

    it('malformed lock JSON → still removes lock, no crash', () => {
        writeFileSync(lockPath(), 'not-json{{{');
        recoverInterruptedCodexLogin(tmpHome);
        expect(existsSync(lockPath())).toBe(false);
    });

    it('live pid + FRESH timestamp → skip (real in-flight login)', () => {
        writeFileSync(authPath(), '{"in_flight_token":true}');
        writeFileSync(backupPath(), '{"original_user_token":true}');
        writeFileSync(lockPath(), JSON.stringify({
            profileName: 'foo',
            pid: process.pid,
            backedUp: true,
            started: new Date().toISOString(), // brand new
        }));

        recoverInterruptedCodexLogin(tmpHome);

        expect(readFileSync(authPath(), 'utf-8')).toBe('{"in_flight_token":true}');
        expect(existsSync(backupPath())).toBe(true);
        expect(existsSync(lockPath())).toBe(true);
    });

    it('live pid + STALE timestamp → recover (PID reuse defense)', () => {
        // Defends against: process A crashes during login, system reuses pid A's
        // number for an unrelated process. Without timestamp gating, recovery would
        // see the (unrelated) live pid and skip — leaving lock permanently held.
        writeFileSync(authPath(), '{"freshly_written":true}');
        writeFileSync(backupPath(), '{"original_user_token":true}');
        const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
        writeFileSync(lockPath(), JSON.stringify({
            profileName: 'foo',
            pid: process.pid, // "alive" but the timestamp is way past device-auth TTL
            backedUp: true,
            started: twoHoursAgo,
        }));

        recoverInterruptedCodexLogin(tmpHome);

        // Recovery proceeded despite live pid: backup restored, lock removed
        expect(readFileSync(authPath(), 'utf-8')).toBe('{"original_user_token":true}');
        expect(existsSync(backupPath())).toBe(false);
        expect(existsSync(lockPath())).toBe(false);
    });

    // ====== Phase state machine tests (round-5 structural fix) ======

    it('phase=started crash → defaultAuthPath UNTOUCHED (proves structural fix)', () => {
        // Critical regression test for the lock-first ordering: if happy crashes
        // BETWEEN acquireLock and updateToSpawned, the lock has phase='started' and
        // codex never ran. The user's original auth.json is still pristine — recovery
        // MUST NOT touch it. Earlier rounds (with the legacy backedUp-only schema)
        // had no way to distinguish this from "crashed after spawn", and could either
        // leave a happy-managed token in place or delete the user's original.
        writeFileSync(authPath(), '{"user_original_token":true}');
        writeFileSync(lockPath(), JSON.stringify({
            profileName: 'foo',
            pid: 999999, // dead
            started: new Date().toISOString(),
            phase: 'started',
            hadOriginal: false,
        }));

        recoverInterruptedCodexLogin(tmpHome);

        // The crucial invariant: defaultAuthPath is unchanged
        expect(readFileSync(authPath(), 'utf-8')).toBe('{"user_original_token":true}');
        expect(existsSync(lockPath())).toBe(false);
    });

    it('phase=spawned + hadOriginal=true + backup → restore from backup', () => {
        writeFileSync(authPath(), '{"codex_wrote_new":true}');
        writeFileSync(backupPath(), '{"user_original":true}');
        writeFileSync(lockPath(), JSON.stringify({
            profileName: 'foo',
            pid: 999999,
            started: new Date().toISOString(),
            phase: 'spawned',
            hadOriginal: true,
        }));

        recoverInterruptedCodexLogin(tmpHome);

        expect(readFileSync(authPath(), 'utf-8')).toBe('{"user_original":true}');
        expect(existsSync(backupPath())).toBe(false);
        expect(existsSync(lockPath())).toBe(false);
    });

    it('phase=spawned + hadOriginal=false + auth.json → delete leftover', () => {
        writeFileSync(authPath(), '{"codex_wrote_new_into_empty_home":true}');
        writeFileSync(lockPath(), JSON.stringify({
            profileName: 'foo',
            pid: 999999,
            started: new Date().toISOString(),
            phase: 'spawned',
            hadOriginal: false,
        }));

        recoverInterruptedCodexLogin(tmpHome);

        expect(existsSync(authPath())).toBe(false);
        expect(existsSync(lockPath())).toBe(false);
    });

    it('phase=spawned + hadOriginal=true + NO backup → log warn, defaultAuth untouched', () => {
        // Rare crash window: backup file vanished (disk error, manual deletion, etc).
        // We can't restore — must leave defaultAuthPath alone rather than risk deleting
        // the user's data.
        writeFileSync(authPath(), '{"may_be_codex_or_original":true}');
        writeFileSync(lockPath(), JSON.stringify({
            profileName: 'foo',
            pid: 999999,
            started: new Date().toISOString(),
            phase: 'spawned',
            hadOriginal: true,
        }));

        recoverInterruptedCodexLogin(tmpHome);

        // defaultAuth left as-is; lock still removed
        expect(existsSync(authPath())).toBe(true);
        expect(existsSync(lockPath())).toBe(false);
    });

    it('phase=started + orphan backup → backup removed, lock removed, auth untouched', () => {
        // Pre-spawn crash that somehow left a backup file behind. Sweep on recovery.
        writeFileSync(authPath(), '{"untouched":true}');
        writeFileSync(backupPath(), '{"orphan":true}');
        writeFileSync(lockPath(), JSON.stringify({
            profileName: 'foo',
            pid: 999999,
            started: new Date().toISOString(),
            phase: 'started',
            hadOriginal: false,
        }));

        recoverInterruptedCodexLogin(tmpHome);

        expect(readFileSync(authPath(), 'utf-8')).toBe('{"untouched":true}');
        expect(existsSync(backupPath())).toBe(false);
        expect(existsSync(lockPath())).toBe(false);
    });

    it('legacy lock format (backedUp field, no phase) → recovers via compat path', () => {
        // Backwards compat: pre-round-5 lock files used `backedUp: bool` and were
        // written right before spawn (so semantically phase='spawned'). Recovery
        // should still handle them correctly.
        writeFileSync(authPath(), '{"codex_wrote_new":true}');
        writeFileSync(backupPath(), '{"user_original":true}');
        writeFileSync(lockPath(), JSON.stringify({
            profileName: 'foo',
            pid: 999999,
            started: new Date().toISOString(),
            backedUp: true, // legacy field, no phase
        }));

        recoverInterruptedCodexLogin(tmpHome);

        expect(readFileSync(authPath(), 'utf-8')).toBe('{"user_original":true}');
        expect(existsSync(backupPath())).toBe(false);
        expect(existsSync(lockPath())).toBe(false);
    });
});

describe('acquireCodexLoginLock', () => {
    let tmpHome: string;
    beforeEach(() => {
        tmpHome = mkdtempSync(join(tmpdir(), 'happy-codex-acquire-'));
    });
    afterEach(() => {
        try { rmSync(tmpHome, { recursive: true, force: true }); } catch { /* best-effort */ }
    });

    it('first acquisition succeeds, writes phase=started lock, returns started ISO', () => {
        const lockFile = join(tmpHome, '.happy-login.lock');
        const before = Date.now();
        const result = acquireCodexLoginLock(lockFile, { profileName: 'foo' });
        expect(result.kind).toBe('acquired');
        if (result.kind !== 'acquired') return;
        expect(Number.isFinite(Date.parse(result.started))).toBe(true);
        expect(Date.parse(result.started)).toBeGreaterThanOrEqual(before);
        expect(existsSync(lockFile)).toBe(true);

        const json = JSON.parse(readFileSync(lockFile, 'utf-8'));
        expect(json.profileName).toBe('foo');
        expect(json.pid).toBe(process.pid);
        expect(json.phase).toBe('started');
        expect(json.hadOriginal).toBe(false);
        expect(json.started).toBe(result.started);
    });

    it('second concurrent acquisition returns busy (TOCTOU defense via O_EXCL)', () => {
        // Regression test for the file-locking textbook bug: a naive existsSync +
        // writeFileSync pattern would let both calls proceed. The wx flag delegates
        // to the kernel's atomic O_CREAT|O_EXCL, so the second call gets EEXIST → busy.
        const lockFile = join(tmpHome, '.happy-login.lock');
        const first = acquireCodexLoginLock(lockFile, { profileName: 'foo' });
        expect(first.kind).toBe('acquired');

        const second = acquireCodexLoginLock(lockFile, { profileName: 'bar' });
        expect(second.kind).toBe('busy');

        // First lock content must be untouched (second call did NOT clobber)
        const json = JSON.parse(readFileSync(lockFile, 'utf-8'));
        expect(json.profileName).toBe('foo');
        expect(json.phase).toBe('started');
    });

    it('error kind on missing parent directory (ENOENT)', () => {
        const result = acquireCodexLoginLock(
            join(tmpHome, 'nonexistent-subdir', '.happy-login.lock'),
            { profileName: 'foo' },
        );
        expect(result.kind).toBe('error');
        if (result.kind !== 'error') return;
        expect(result.error).toBeInstanceOf(Error);
    });
});

describe('updateCodexLoginLockToSpawned', () => {
    let tmpHome: string;
    beforeEach(() => {
        tmpHome = mkdtempSync(join(tmpdir(), 'happy-codex-update-'));
    });
    afterEach(() => {
        try { rmSync(tmpHome, { recursive: true, force: true }); } catch { /* best-effort */ }
    });

    it('transitions phase=started → spawned, preserves started + profileName + pid', () => {
        const lockFile = join(tmpHome, '.happy-login.lock');
        const acquired = acquireCodexLoginLock(lockFile, { profileName: 'alpha' });
        expect(acquired.kind).toBe('acquired');
        if (acquired.kind !== 'acquired') return;
        const originalStarted = acquired.started;

        updateCodexLoginLockToSpawned(lockFile, {
            profileName: 'alpha',
            started: originalStarted,
            hadOriginal: true,
        });

        const json = JSON.parse(readFileSync(lockFile, 'utf-8'));
        expect(json.phase).toBe('spawned');
        expect(json.hadOriginal).toBe(true);
        expect(json.started).toBe(originalStarted);
        expect(json.profileName).toBe('alpha');
        expect(json.pid).toBe(process.pid);
    });

    it('records hadOriginal=false correctly', () => {
        const lockFile = join(tmpHome, '.happy-login.lock');
        const acquired = acquireCodexLoginLock(lockFile, { profileName: 'beta' });
        if (acquired.kind !== 'acquired') return;
        updateCodexLoginLockToSpawned(lockFile, {
            profileName: 'beta',
            started: acquired.started,
            hadOriginal: false,
        });
        const json = JSON.parse(readFileSync(lockFile, 'utf-8'));
        expect(json.phase).toBe('spawned');
        expect(json.hadOriginal).toBe(false);
    });
});
