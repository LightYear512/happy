/**
 * Fake codex `app-server` testkit — spawns a tiny user-supplied Node.js
 * script that speaks the JSONRPC-over-stdio protocol so we can exercise
 * `runCodexWithAppServer()` end-to-end without a real codex binary.
 *
 * Why a child process at all (vs. mocking the client class)?
 *   The interesting bugs in this layer live at the stdio framing /
 *   readline / process-lifecycle boundary (Windows .cmd shim wrapping,
 *   premature exit, half-flushed stdout, race between RPC reply and
 *   notification). Mocks short-circuit exactly those code paths. By
 *   writing a real .mjs script and pointing `HAPPY_CODEX_APP_SERVER_BIN`
 *   at it, the production spawn path runs verbatim against a child we
 *   fully control — same shape as how `runCodexAppServer.ts` would
 *   spawn the real `codex app-server` subprocess in production.
 *
 * Industry parallel: same pattern as
 *   - Docker's `docker-credential-helper` integration tests (drop a
 *     tiny exec on PATH that prints scripted JSON to stdout)
 *   - Git's `GIT_SSH_COMMAND` test pattern (point at a shell stub
 *     that records args and returns canned bytes)
 *   - kubectl's krew tests (write a fake plugin binary, exec it,
 *     assert behaviour via observable output)
 * In every case the contract under test is "spawn + framed IO", and a
 * stubbed child is the only way to cover the framing without rebuilding
 * the production spawn machinery in test code.
 *
 * Lifecycle: env-key scope MUST be used by callers (see
 * `createCodexAppServerTestEnvScope`) — vitest workers are reused across
 * tests, so a leaked `HAPPY_CODEX_APP_SERVER_BIN` from one suite will
 * silently hijack the next suite's runtime. The scope's `restore()`
 * deletes keys that were unset before the test, so isolation is
 * unconditional regardless of which keys each test set.
 *
 * Ported from happier's reference impl at
 * `apps/cli/src/backends/codex/appServer/testkit/fakeCodexAppServer.ts`.
 * Adaptations: `HAPPIER_*` env keys renamed to `HAPPY_*`; envScope
 * dependency replaced with the inline helper below; the happier-specific
 * `writeFakeCodexAppServerThreadListScript` helper is intentionally not
 * ported (thread/list listing is not wired in happy-cli).
 */

import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Env keys whose values we capture before a test and restore after.
 *
 * Two categories live here:
 *   1. happy-cli-owned knobs (`HAPPY_CODEX_APP_SERVER_*`) — these we
 *      explicitly set per-test; restore must un-set them so a later
 *      test that omits them sees the real default behaviour.
 *   2. shared codex auth keys (`CODEX_HOME`, `OPENAI_API_KEY`) — the
 *      developer running tests may legitimately have these in their
 *      shell env for ad-hoc codex use; restore must put them back so
 *      we don't strand the workstation in a half-clean state.
 *
 * `HAPPY_TRANSCRIPT_STORAGE` is kept for forward-parity with happier
 * even though happy-cli does not currently consume it — cheaper to
 * include now than to discover a hijack later when the feature lands.
 */
const CODEX_APP_SERVER_TEST_ENV_KEYS = [
    'HAPPY_CODEX_APP_SERVER_BIN',
    'HAPPY_CODEX_APP_SERVER_RPC_TIMEOUT_MS',
    'HAPPY_CODEX_APP_SERVER_STARTUP_RPC_TIMEOUT_MS',
    'HAPPY_CODEX_APP_SERVER_THREAD_LIST_PAGE_SIZE',
    'HAPPY_TEST_AGENT_MESSAGE_MODE',
    'HAPPY_TRANSCRIPT_STORAGE',
    'HAPPY_HOME_DIR',
    'CODEX_HOME',
    'OPENAI_API_KEY',
] as const;

/**
 * Snapshot + restore a fixed set of env keys around a test.
 *
 * Why a frozen key list (vs. snapshot-all-of-process.env)? Snapshotting
 * the whole env is O(env-size) per test and — worse — accidentally
 * "freezes" keys that legitimate parallel infrastructure (telemetry
 * agents, shell init scripts) may rewrite during the test. By naming
 * the keys we care about, we leave everything else alone.
 *
 * Deliberately tiny — this is the only place happy-cli needs env
 * scoping at the moment, so we avoid importing a heavier testkit.
 */
export function createEnvKeyScope(keys: readonly string[]): {
    save: () => void;
    restore: () => void;
} {
    let baseline: Map<string, string | undefined> | null = null;
    return {
        save(): void {
            const snap = new Map<string, string | undefined>();
            for (const key of keys) {
                snap.set(key, process.env[key]);
            }
            baseline = snap;
        },
        restore(): void {
            if (baseline === null) return;
            for (const key of keys) {
                const value = baseline.get(key);
                if (value === undefined) {
                    delete process.env[key];
                } else {
                    process.env[key] = value;
                }
            }
        },
    };
}

/**
 * Convenience factory pre-bound to the codex app-server env keys —
 * matches happier's API surface so test code ports across cleanly.
 */
export function createCodexAppServerTestEnvScope(): {
    save: () => void;
    restore: () => void;
} {
    return createEnvKeyScope(CODEX_APP_SERVER_TEST_ENV_KEYS);
}

/**
 * Build the `NodeJS.ProcessEnv` to hand to a child `runCodexWithAppServer`
 * invocation. Defaults to a 2-second RPC timeout because tests should fail
 * fast — real production timeout is much larger but a hang here means a
 * fake-script bug, and waiting 60 s to surface it makes iteration painful.
 *
 * `overrides` wins over the defaults so individual tests can opt into
 * longer timeouts, custom log paths, etc. without forking this helper.
 */
export function createCodexAppServerProcessEnv(
    fakeAppServer: string,
    overrides: Readonly<NodeJS.ProcessEnv> = {},
): NodeJS.ProcessEnv {
    return {
        ...process.env,
        HAPPY_CODEX_APP_SERVER_BIN: fakeAppServer,
        HAPPY_CODEX_APP_SERVER_RPC_TIMEOUT_MS: '2000',
        ...overrides,
    };
}

/**
 * Write a tiny `.mjs` script that implements the codex JSONRPC stdio
 * protocol on demand. `bodyLines` is the per-message dispatcher (i.e.
 * the `for await (const line of rl) { ... }` loop body, including the
 * outer `for await` itself — see the README's example for shape).
 *
 * Three injection points so tests stay readable:
 *   - `importLines` runs before readline is set up (rare: only needed
 *     if the script wants `fs`/`path`/etc. — pure JSONRPC stub does not)
 *   - `setupLines` runs after readline is set up but before the
 *     dispatcher — for declaring state captured by closures in bodyLines
 *     (`let turnCount = 0;`, scripted thread/turn IDs, etc.)
 *   - `bodyLines` is the dispatcher itself
 *
 * The script is written with mode `0o755` so it's executable on POSIX;
 * on Windows the .mjs extension + node shebang are how `node` resolves
 * the interpreter (the exec bit is harmless / ignored).
 */
export async function writeFakeCodexAppServerScript(params: Readonly<{
    dir: string;
    bodyLines: readonly string[];
    importLines?: readonly string[];
    setupLines?: readonly string[];
    fileName?: string;
}>): Promise<string> {
    const scriptPath = join(params.dir, params.fileName ?? 'fake-codex-app-server.mjs');
    const script = [
        '#!/usr/bin/env node',
        ...(params.importLines ?? []),
        'import readline from "node:readline";',
        'const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });',
        ...(params.setupLines ?? []),
        ...params.bodyLines,
    ].join('\n');
    await writeFile(scriptPath, script, { encoding: 'utf8', mode: 0o755 });
    return scriptPath;
}
