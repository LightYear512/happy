import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { buildCodexChildEnv, CODEX_PROXY_KEY_PAIRS, CODEX_DIAGNOSTIC_ENV_KEYS } from './codexEnvBuilder';

describe('buildCodexChildEnv', () => {
    let tmpDir: string;
    let dotenvPath: string;

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-env-test-'));
        dotenvPath = path.join(tmpDir, '.env');
    });

    afterEach(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    describe('Step 1: copy baseEnv', () => {
        it('copies string values, drops undefined', () => {
            const result = buildCodexChildEnv({
                baseEnv: { FOO: 'bar', BAZ: undefined, NUM: '42' },
                dotenvPath,
                emitLogs: false,
            });
            expect(result.env.FOO).toBe('bar');
            expect(result.env.NUM).toBe('42');
            expect('BAZ' in result.env).toBe(false);
        });

        it('defaults baseEnv to process.env (smoke test — must contain PATH)', () => {
            const result = buildCodexChildEnv({ dotenvPath, emitLogs: false });
            expect(typeof result.env.PATH).toBe('string');
        });
    });

    describe('Step 2: keysToDelete', () => {
        it('deletes named keys from copied env', () => {
            const result = buildCodexChildEnv({
                baseEnv: { CODEX_HOME: '/tmp/x', KEEP: 'yes' },
                dotenvPath,
                keysToDelete: ['CODEX_HOME'],
                emitLogs: false,
            });
            expect('CODEX_HOME' in result.env).toBe(false);
            expect(result.env.KEEP).toBe('yes');
        });

        it('is a no-op when key is absent', () => {
            const result = buildCodexChildEnv({
                baseEnv: { KEEP: 'yes' },
                dotenvPath,
                keysToDelete: ['ABSENT'],
                emitLogs: false,
            });
            expect(result.env.KEEP).toBe('yes');
        });
    });

    describe('Step 3: dotenv proxy inject', () => {
        it('injects HTTPS_PROXY from .env when not in baseEnv', () => {
            fs.writeFileSync(dotenvPath, 'HTTPS_PROXY=http://proxy.example:8080\n');
            const result = buildCodexChildEnv({
                baseEnv: {},
                dotenvPath,
                emitLogs: false,
            });
            expect(result.env.HTTPS_PROXY).toBe('http://proxy.example:8080');
            expect(result.env.https_proxy).toBe('http://proxy.example:8080');
            expect(result.dotenvInjectReport['https_proxy/HTTPS_PROXY']).toMatch(/injected from/);
        });

        it('does NOT overwrite HTTPS_PROXY already set in baseEnv (uppercase)', () => {
            fs.writeFileSync(dotenvPath, 'HTTPS_PROXY=http://from-dotenv:8080\n');
            const result = buildCodexChildEnv({
                baseEnv: { HTTPS_PROXY: 'http://user-set:9000' },
                dotenvPath,
                emitLogs: false,
            });
            expect(result.env.HTTPS_PROXY).toBe('http://user-set:9000');
            expect(result.dotenvInjectReport.https_proxy).toBe('skipped (already in childEnv)');
        });

        it('does NOT overwrite when only lowercase form is present in baseEnv', () => {
            // Case-insensitive presence check — tests the protection against
            // "user has https_proxy set, .env tries to inject HTTPS_PROXY".
            fs.writeFileSync(dotenvPath, 'HTTPS_PROXY=http://from-dotenv:8080\n');
            const result = buildCodexChildEnv({
                baseEnv: { https_proxy: 'http://lowercase-user:9000' },
                dotenvPath,
                emitLogs: false,
            });
            expect(result.env.https_proxy).toBe('http://lowercase-user:9000');
            // Inject is skipped; mirror later upcases it.
            expect(result.env.HTTPS_PROXY).toBe('http://lowercase-user:9000');
        });

        it('strips surrounding double and single quotes from value', () => {
            fs.writeFileSync(dotenvPath, `HTTPS_PROXY="http://quoted:8080"\nHTTP_PROXY='http://single:8080'\n`);
            const result = buildCodexChildEnv({
                baseEnv: {},
                dotenvPath,
                emitLogs: false,
            });
            expect(result.env.HTTPS_PROXY).toBe('http://quoted:8080');
            expect(result.env.HTTP_PROXY).toBe('http://single:8080');
        });

        it('skips comments and blank lines', () => {
            fs.writeFileSync(dotenvPath, '# a comment\n\nHTTPS_PROXY=http://ok:8080\n   \n# another\n');
            const result = buildCodexChildEnv({
                baseEnv: {},
                dotenvPath,
                emitLogs: false,
            });
            expect(result.env.HTTPS_PROXY).toBe('http://ok:8080');
        });

        it('skips lines without `=`', () => {
            fs.writeFileSync(dotenvPath, 'NO_EQUALS_LINE\nHTTPS_PROXY=http://ok:8080\n');
            const result = buildCodexChildEnv({
                baseEnv: {},
                dotenvPath,
                emitLogs: false,
            });
            expect(result.env.HTTPS_PROXY).toBe('http://ok:8080');
        });

        it('ignores non-proxy keys in dotenv', () => {
            fs.writeFileSync(dotenvPath, 'OPENAI_API_KEY=sk-secret\nHTTPS_PROXY=http://ok:8080\n');
            const result = buildCodexChildEnv({
                baseEnv: {},
                dotenvPath,
                emitLogs: false,
            });
            expect(result.env.HTTPS_PROXY).toBe('http://ok:8080');
            expect('OPENAI_API_KEY' in result.env).toBe(false);
        });

        it('is a no-op when dotenvPath does not exist', () => {
            const result = buildCodexChildEnv({
                baseEnv: { FOO: 'bar' },
                dotenvPath: path.join(tmpDir, 'nope.env'),
                emitLogs: false,
            });
            expect(result.env.FOO).toBe('bar');
            expect(Object.keys(result.dotenvInjectReport).length).toBe(0);
        });
    });

    describe('Step 4: upper↔lower proxy mirror', () => {
        it('mirrors uppercase to lowercase when only uppercase is set', () => {
            const result = buildCodexChildEnv({
                baseEnv: { HTTPS_PROXY: 'http://upper:8080' },
                dotenvPath,
                emitLogs: false,
            });
            expect(result.env.https_proxy).toBe('http://upper:8080');
            expect(result.proxyMirrorReport.https_proxy).toBe('mirrored ← HTTPS_PROXY');
        });

        it('mirrors lowercase to uppercase when only lowercase is set', () => {
            const result = buildCodexChildEnv({
                baseEnv: { http_proxy: 'http://lower:8080' },
                dotenvPath,
                emitLogs: false,
            });
            expect(result.env.HTTP_PROXY).toBe('http://lower:8080');
            expect(result.proxyMirrorReport.HTTP_PROXY).toBe('mirrored ← http_proxy');
        });

        it('reports identical-both-set as no-op', () => {
            const result = buildCodexChildEnv({
                baseEnv: { HTTPS_PROXY: 'http://x:8080', https_proxy: 'http://x:8080' },
                dotenvPath,
                emitLogs: false,
            });
            expect(result.proxyMirrorReport['HTTPS_PROXY/https_proxy']).toBe('both set, identical (no-op)');
        });

        it('preserves user-explicit divergent values', () => {
            const result = buildCodexChildEnv({
                baseEnv: { HTTPS_PROXY: 'http://up:8080', https_proxy: 'http://lo:9000' },
                dotenvPath,
                emitLogs: false,
            });
            expect(result.env.HTTPS_PROXY).toBe('http://up:8080');
            expect(result.env.https_proxy).toBe('http://lo:9000');
            expect(result.proxyMirrorReport['HTTPS_PROXY/https_proxy']).toMatch(/DIFFERENT/);
        });

        it('handles all four proxy pair types', () => {
            const result = buildCodexChildEnv({
                baseEnv: {
                    HTTPS_PROXY: 'a',
                    http_proxy: 'b',
                    NO_PROXY: 'c',
                    all_proxy: 'd',
                },
                dotenvPath,
                emitLogs: false,
            });
            // All four pairs should be mirrored to the missing case.
            for (const [upper, lower] of CODEX_PROXY_KEY_PAIRS) {
                expect(result.env[upper]).toBeDefined();
                expect(result.env[lower]).toBeDefined();
            }
        });
    });

    describe('Step 5: diagnostic snapshot', () => {
        it('masks proxy auth credentials', () => {
            const result = buildCodexChildEnv({
                baseEnv: { HTTPS_PROXY: 'http://user:pass@proxy.example:8080' },
                dotenvPath,
                emitLogs: false,
            });
            expect(result.envSnapshot.HTTPS_PROXY).toBe('http://<auth>@proxy.example:8080');
        });

        it('summarizes PATH as entry count, not full value', () => {
            const result = buildCodexChildEnv({
                baseEnv: { PATH: '/usr/bin:/bin:/usr/local/bin' },
                dotenvPath,
                emitLogs: false,
            });
            expect(result.envSnapshot.PATH).toBe('<3 entries>');
        });

        it('counts segments using both : and ; as separators (cross-platform PATH)', () => {
            // Pre-existing implementation splits on /[;:]/ — note this is over-eager
            // for Windows paths with drive letters (`C:\foo;D:\bar` splits into 4),
            // but it's fine for the diagnostic snapshot's "approximate count" purpose.
            const result = buildCodexChildEnv({
                baseEnv: { PATH: '/usr/bin;/bin' },
                dotenvPath,
                emitLogs: false,
            });
            expect(result.envSnapshot.PATH).toBe('<2 entries>');
        });

        it('masks OPENAI_API_KEY length only, not value', () => {
            const result = buildCodexChildEnv({
                baseEnv: { OPENAI_API_KEY: 'sk-abcdefghij' },
                dotenvPath,
                emitLogs: false,
            });
            expect(result.envSnapshot.OPENAI_API_KEY).toBe('<set, len=13>');
        });

        it('only includes keys matching CODEX_DIAGNOSTIC_ENV_KEYS regex', () => {
            const result = buildCodexChildEnv({
                baseEnv: {
                    HTTPS_PROXY: 'http://x',
                    SOME_RANDOM_KEY: 'noise',
                    CODEX_THREAD_ID: 'tid-123',
                },
                dotenvPath,
                emitLogs: false,
            });
            expect('HTTPS_PROXY' in result.envSnapshot).toBe(true);
            expect('CODEX_THREAD_ID' in result.envSnapshot).toBe(true);
            expect('SOME_RANDOM_KEY' in result.envSnapshot).toBe(false);
        });

        it('snapshot is built regardless of emitLogs flag (return-value contract)', () => {
            // Logging is independent of building — caller may want the snapshot for
            // structured telemetry without the logger.info side-effect.
            const result = buildCodexChildEnv({
                baseEnv: { HTTPS_PROXY: 'http://x' },
                dotenvPath,
                emitLogs: false,
            });
            expect(result.envSnapshot.HTTPS_PROXY).toBe('http://x');
        });
    });

    describe('dotenv unmatched line behavior (motdotla/dotenv convention)', () => {
        it('silently ignores `export KEY=val` shell-style prefix without crashing', () => {
            // We follow Node's motdotla/dotenv: do NOT strip `export `. Key parses
            // as `'export HTTPS_PROXY'` which matches no pair, line is dropped with
            // a debug log. Compared with Python/Go/Rust dotenv (which strip), users
            // coming from those ecosystems may need to remove the prefix manually.
            fs.writeFileSync(dotenvPath, 'export HTTPS_PROXY=http://noop:8080\nFOO=bar\n');
            const result = buildCodexChildEnv({
                baseEnv: {},
                dotenvPath,
                emitLogs: false,
            });
            expect('HTTPS_PROXY' in result.env).toBe(false);
            expect('https_proxy' in result.env).toBe(false);
            expect('export HTTPS_PROXY' in result.env).toBe(false);
            expect('FOO' in result.env).toBe(false);
        });

        it('non-proxy keys (OPENAI_API_KEY, FOO) are silently ignored', () => {
            fs.writeFileSync(dotenvPath, 'OPENAI_API_KEY=sk-secret\nFOO=bar\nHTTPS_PROXY=http://ok:8080\n');
            const result = buildCodexChildEnv({
                baseEnv: {},
                dotenvPath,
                emitLogs: false,
            });
            expect(result.env.HTTPS_PROXY).toBe('http://ok:8080');
            expect('OPENAI_API_KEY' in result.env).toBe(false);
            expect('FOO' in result.env).toBe(false);
        });
    });

    describe('CODEX_DIAGNOSTIC_ENV_KEYS regex', () => {
        it('matches all expected env keys', () => {
            const expectedKeys = [
                'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'ALL_PROXY',
                'REQUESTS_CA_BUNDLE', 'SSL_CERT_FILE', 'NODE_EXTRA_CA_CERTS',
                'CODEX_HOME', 'OPENAI_API_KEY', 'XDG_CONFIG_HOME',
                'LANG', 'LC_ALL', 'TZ', 'HOME', 'TMPDIR', 'PATH', 'SHELL',
            ];
            for (const k of expectedKeys) {
                expect(CODEX_DIAGNOSTIC_ENV_KEYS.test(k)).toBe(true);
            }
        });

        it('rejects unrelated keys', () => {
            const rejected = ['FOO', 'NODE_ENV', 'DEBUG', 'npm_package_name'];
            for (const k of rejected) {
                expect(CODEX_DIAGNOSTIC_ENV_KEYS.test(k)).toBe(false);
            }
        });
    });

    describe('integration: dotenv inject + mirror combined', () => {
        it('dotenv injects uppercase, mirror does NOT report it (single-source)', () => {
            // When dotenv injects both upper and lower in one shot (current behavior),
            // the mirror step sees both already set with identical values → reports
            // "both set, identical (no-op)" rather than re-mirroring.
            fs.writeFileSync(dotenvPath, 'HTTPS_PROXY=http://from-dotenv:8080\n');
            const result = buildCodexChildEnv({
                baseEnv: {},
                dotenvPath,
                emitLogs: false,
            });
            expect(result.env.HTTPS_PROXY).toBe('http://from-dotenv:8080');
            expect(result.env.https_proxy).toBe('http://from-dotenv:8080');
            expect(result.proxyMirrorReport['HTTPS_PROXY/https_proxy']).toBe('both set, identical (no-op)');
        });

        it('user lowercase + dotenv has uppercase → user wins, both cases populated', () => {
            // User set https_proxy in shell. .env wants to inject HTTPS_PROXY.
            // Inject is skipped (case-insensitive presence check), mirror copies
            // user's lowercase value up.
            fs.writeFileSync(dotenvPath, 'HTTPS_PROXY=http://from-dotenv:8080\n');
            const result = buildCodexChildEnv({
                baseEnv: { https_proxy: 'http://user-shell:9000' },
                dotenvPath,
                emitLogs: false,
            });
            expect(result.env.https_proxy).toBe('http://user-shell:9000');
            expect(result.env.HTTPS_PROXY).toBe('http://user-shell:9000');
        });
    });
});
