/**
 * Smoke test for the fake-codex-app-server testkit.
 *
 * Why this exists
 * ---------------
 * `eb04ef44` landed the env override (`HAPPY_CODEX_APP_SERVER_BIN`) and the
 * `writeFakeCodexAppServerScript` / `createCodexAppServerProcessEnv` /
 * `createCodexAppServerTestEnvScope` helpers, but nothing in the repo actually
 * proves they wire up end-to-end against a real spawn on Windows. This test
 * is the missing proof — it pins the smallest interesting contract:
 *
 *   1. envScope.save()/restore() isolates the env across tests
 *   2. createCodexAppServerProcessEnv() actually sets HAPPY_CODEX_APP_SERVER_BIN
 *   3. createCodexAppServerClient({ processEnv }) spawns the fake binary,
 *      completes the JSONRPC `initialize` handshake, and is ready to
 *      receive notifications
 *   4. A fake-emitted `error` notification with the verbatim production-shape
 *      payload (the one captured from a live auto-rescue, fixture comes from
 *      `codexAutoRescue.test.ts`) reaches a registered notification handler
 *      with byte-equal params — this is the exact shape `runCodexAppServer.ts`
 *      routes through `shouldAutoRescue` in production
 *   5. dispose() exits cleanly
 *
 * Windows-specific adaptation
 * ---------------------------
 * `codexAppServerClient.buildWindowsSpawnArgs` wraps the override binary in
 * `cmd.exe /d /s /c "<bin> app-server --listen stdio://"`. cmd.exe has no
 * file association for `.mjs` (confirmed via `assoc .mjs` → "File association
 * not found"), so pointing the override directly at a `.mjs` file would
 * silently fail. We therefore write a `.cmd` shim on Windows that just
 * forwards to `node "<mjs-path>" %*` — this is structurally identical to how
 * npm-installed CLIs (including the real `codex.cmd`) bootstrap on Windows,
 * so the test exercises the exact same spawn machinery the production binary
 * would hit.
 *
 * On POSIX the `.mjs` shebang (`#!/usr/bin/env node`) is honoured directly
 * by `execve`, no shim needed.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createCodexAppServerClient } from '../../codexAppServerClient';
import {
    createCodexAppServerProcessEnv,
    createCodexAppServerTestEnvScope,
    writeFakeCodexAppServerScript,
} from './fakeCodexAppServer';

const envScope = createCodexAppServerTestEnvScope();
let workDir: string | null = null;

beforeEach(async () => {
    envScope.save();
    workDir = await mkdtemp(join(tmpdir(), 'happy-fake-codex-smoke-'));
});

afterEach(async () => {
    envScope.restore();
    if (workDir !== null) {
        await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
        workDir = null;
    }
});

/**
 * Return a binary path the production spawn pipeline can actually execute.
 *
 * On POSIX, the `.mjs` shebang line is honoured by `execve`, so we hand back
 * the raw script path. On Windows, `cmd.exe` (which `buildWindowsSpawnArgs`
 * wraps us in) does not associate `.mjs` with `node`, so we drop a tiny
 * `.cmd` shim next to the script that re-invokes via `node` and return the
 * shim's path. The shim shape (`@echo off`, `node "<path>" %*`) is the same
 * pattern npm uses for its CLI bin entries.
 */
async function makeInvokableBinary(scriptPath: string, dir: string): Promise<string> {
    if (process.platform !== 'win32') return scriptPath;
    const shimPath = join(dir, 'fake-codex-app-server.cmd');
    const shim = ['@echo off', `node "${scriptPath}" %*`, ''].join('\r\n');
    await writeFile(shimPath, shim, { encoding: 'utf8' });
    return shimPath;
}

describe('fakeCodexAppServer testkit — smoke', () => {
    it('createCodexAppServerTestEnvScope isolates HAPPY_CODEX_APP_SERVER_BIN across save/restore', () => {
        // Snapshot the baseline (whatever the harness env happens to hold).
        const baseline = process.env.HAPPY_CODEX_APP_SERVER_BIN;
        // Mutate inside the scope.
        process.env.HAPPY_CODEX_APP_SERVER_BIN = '/sentinel/path/should-not-leak';
        expect(process.env.HAPPY_CODEX_APP_SERVER_BIN).toBe('/sentinel/path/should-not-leak');
        // Restore should undo it (afterEach will also fire, but we want to
        // assert restore() itself is the source of truth — not just that
        // afterEach happens to run later).
        envScope.restore();
        expect(process.env.HAPPY_CODEX_APP_SERVER_BIN).toBe(baseline);
        // Re-arm the scope so the outer afterEach has something to restore.
        envScope.save();
    });

    it('createCodexAppServerProcessEnv copies process.env and sets HAPPY_CODEX_APP_SERVER_BIN + default RPC timeout', () => {
        const env = createCodexAppServerProcessEnv('/path/to/fake-codex');
        expect(env.HAPPY_CODEX_APP_SERVER_BIN).toBe('/path/to/fake-codex');
        expect(env.HAPPY_CODEX_APP_SERVER_RPC_TIMEOUT_MS).toBe('2000');
        // Overrides win
        const env2 = createCodexAppServerProcessEnv('/path/to/fake-codex', {
            HAPPY_CODEX_APP_SERVER_RPC_TIMEOUT_MS: '5000',
        });
        expect(env2.HAPPY_CODEX_APP_SERVER_RPC_TIMEOUT_MS).toBe('5000');
    });

    it('spawns the fake binary, completes initialize handshake, and delivers a verbatim error notification to the registered handler', async () => {
        expect(workDir).not.toBeNull();
        if (!workDir) return;

        // ── 1. Author the fake script. It answers `initialize`, ignores the
        //      `initialized` notification, then fires the production-shape
        //      `error` notification once on demand (the dispatcher waits for
        //      a `__test/fireError` request from the client — so the test
        //      controls the exact moment of emission and avoids racing the
        //      handler registration).
        const fakeScript = await writeFakeCodexAppServerScript({
            dir: workDir,
            bodyLines: [
                'const send = (obj) => process.stdout.write(JSON.stringify(obj) + "\\n");',
                'for await (const line of rl) {',
                '  if (!line.trim()) continue;',
                '  let msg;',
                '  try { msg = JSON.parse(line); } catch { continue; }',
                '  if (msg.method === "initialize") {',
                '    send({ id: msg.id, result: { serverInfo: { name: "fake-codex-smoke", version: "0.0.0" } } });',
                '    continue;',
                '  }',
                '  if (msg.method === "initialized") continue;',
                '  if (msg.method === "__test/fireError") {',
                '    // Emit the verbatim production-shape error notification. This is the',
                '    // EXACT payload that triggered auto-rescue in production logs (see',
                '    // codexAutoRescue.test.ts L82-92).',
                '    send({',
                '      method: "error",',
                '      params: {',
                '        error: {',
                '          message: "Error running remote compact task: stream disconnected before completion: error sending request for url (https://chatgpt.com/backend-api/codex/responses/compact)",',
                '          codexErrorInfo: "other",',
                '          additionalDetails: null,',
                '        },',
                '        willRetry: false,',
                '        threadId: "simcompact-fake-thread",',
                '        turnId: "simcompact-fake-turn",',
                '      },',
                '    });',
                '    send({ id: msg.id, result: { fired: true } });',
                '    continue;',
                '  }',
                '  send({ id: msg.id, error: { code: -32601, message: `method not found: ${msg.method}` } });',
                '}',
            ],
        });

        // ── 2. On Windows, wrap with a .cmd shim. On POSIX, pass the .mjs path
        //      directly (shebang handles it).
        const invokableBin = await makeInvokableBinary(fakeScript, workDir);

        // ── 3. Wire up the env override. `resolveCodexBinary()` in
        //      `codexAppServerClient.ts:155-176` reads `process.env`
        //      directly (not the `opts.processEnv` parameter), so the override
        //      MUST live on `process.env`. The envScope save/restore around
        //      every test guarantees this doesn't leak.
        //
        //      `createCodexAppServerProcessEnv()` is then used to build the
        //      child's environment so the spawned fake inherits everything
        //      plus any per-test knobs (RPC timeout, etc.). It also sets
        //      HAPPY_CODEX_APP_SERVER_BIN inside that child env — harmless,
        //      because the fake script doesn't read it; the override only
        //      matters in the *parent* process where `resolveCodexBinary`
        //      runs before spawn.
        process.env.HAPPY_CODEX_APP_SERVER_BIN = invokableBin;
        const processEnv = createCodexAppServerProcessEnv(invokableBin, {
            // Bump the per-RPC timeout a touch — Windows cmd.exe spawn + node
            // cold-start can comfortably eat 1.5s, and the default 2s makes
            // CI flakes annoying. 8s is still fast-fail for a real hang.
            HAPPY_CODEX_APP_SERVER_RPC_TIMEOUT_MS: '8000',
        });

        // ── 4. Spawn the client. This RUNS the full production initialize
        //      handshake (initialize request + initialized notification),
        //      proving the env override + spawn + stdio framing all work.
        const client = await createCodexAppServerClient({
            processEnv: processEnv as Record<string, string>,
            cwd: workDir,
        });

        try {
            // ── 5. Register the notification handler, then ask the fake to
            //      fire. Using a Promise gate so we deterministically wait
            //      for delivery instead of polling.
            let received: unknown = null;
            const seen = new Promise<unknown>((resolve) => {
                client.registerNotificationHandler('error', (params: unknown) => {
                    received = params;
                    resolve(params);
                });
            });

            const fireResult = (await client.request('__test/fireError')) as { fired?: boolean };
            expect(fireResult.fired).toBe(true);

            // ── 6. Assert byte-equal delivery. This is what
            //      `runCodexAppServer.ts:1100` would route through
            //      `shouldAutoRescue` in production.
            const params = await seen;
            expect(params).toEqual({
                error: {
                    message:
                        'Error running remote compact task: stream disconnected before completion: error sending request for url (https://chatgpt.com/backend-api/codex/responses/compact)',
                    codexErrorInfo: 'other',
                    additionalDetails: null,
                },
                willRetry: false,
                threadId: 'simcompact-fake-thread',
                turnId: 'simcompact-fake-turn',
            });
            expect(received).toBe(params); // synchronous handler ran
        } finally {
            await client.dispose();
        }
    }, 20_000);
});
