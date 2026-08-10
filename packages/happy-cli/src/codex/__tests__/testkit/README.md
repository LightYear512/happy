# `fakeCodexAppServer` testkit

## Why this exists

`runCodexWithAppServer` spawns the real `codex app-server` binary and talks JSONRPC over its stdio. Tests for that layer that mock the client class miss exactly the bugs that hurt most in production: stdio framing, Windows `.cmd` shim wrapping, readline backpressure, half-flushed stdout on premature exit, and races between RPC replies and notifications. This testkit replaces the **binary**, not the client: callers write a tiny Node.js `.mjs` script that implements the JSONRPC dispatcher however they like, point `HAPPY_CODEX_APP_SERVER_BIN` at it, and the production spawn path runs verbatim against a child they fully control.

## Env vars the testkit manages

`createCodexAppServerTestEnvScope()` snapshots and restores these keys:

| Key                                              | Owned by  | Purpose                                          |
| ------------------------------------------------ | --------- | ------------------------------------------------ |
| `HAPPY_CODEX_APP_SERVER_BIN`                     | happy-cli | Path to the fake script (set by testkit)         |
| `HAPPY_CODEX_APP_SERVER_RPC_TIMEOUT_MS`          | happy-cli | Per-call RPC timeout (default 2000 in tests)     |
| `HAPPY_CODEX_APP_SERVER_STARTUP_RPC_TIMEOUT_MS`  | happy-cli | First-RPC (initialize) timeout                   |
| `HAPPY_CODEX_APP_SERVER_THREAD_LIST_PAGE_SIZE`   | happy-cli | thread/list pagination (reserved, not used yet)  |
| `HAPPY_TRANSCRIPT_STORAGE`                       | happy-cli | Reserved for forward-parity with happier         |
| `CODEX_HOME`                                     | codex     | Where codex auth + history live                  |
| `OPENAI_API_KEY`                                 | codex     | Auth fallback                                    |

The scope is `{ save(), restore() }`. `save()` snapshots current values; `restore()` puts them back exactly (deleting keys that were previously unset).

## Minimal usage example

The fake script below answers `initialize`, accepts `thread/start`, returns a `turnId` for `turn/start`, then pushes a `turn/completed` notification so the client's pending-turn promise resolves.

```ts
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'vitest';

import {
    createCodexAppServerProcessEnv,
    createCodexAppServerTestEnvScope,
    writeFakeCodexAppServerScript,
} from './testkit/fakeCodexAppServer';

const envScope = createCodexAppServerTestEnvScope();
beforeEach(() => envScope.save());
afterEach(() => envScope.restore());

test('completes a single turn', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fake-codex-'));
    const fakeBin = await writeFakeCodexAppServerScript({
        dir,
        setupLines: ['let nextTurn = 1;'],
        bodyLines: [
            'for await (const line of rl) {',
            '  if (!line.trim()) continue;',
            '  const msg = JSON.parse(line);',
            '  const reply = (result) => process.stdout.write(JSON.stringify({ id: msg.id, result }) + "\\n");',
            '  const notify = (method, params) => process.stdout.write(JSON.stringify({ method, params }) + "\\n");',
            '  if (msg.method === "initialize") { reply({ serverInfo: { name: "fake", version: "0.0.0" } }); continue; }',
            '  if (msg.method === "initialized") continue;',
            '  if (msg.method === "thread/start") { reply({ threadId: "t-1" }); continue; }',
            '  if (msg.method === "turn/start") {',
            '    const turnId = `turn-${nextTurn++}`;',
            '    reply({ turnId });',
            '    setTimeout(() => notify("turn/completed", { turnId }), 5);',
            '    continue;',
            '  }',
            '  process.stdout.write(JSON.stringify({ id: msg.id, error: { code: -32601, message: "method not found" } }) + "\\n");',
            '}',
        ],
    });
    const env = createCodexAppServerProcessEnv(fakeBin);
    // ... pass `env` to runCodexWithAppServer or codexAppServerClient under test
});
```

## Port notes

Ported from happier's reference impl:

```
E:/happy-claude/workspace/happier/apps/cli/src/backends/codex/appServer/testkit/fakeCodexAppServer.ts
```

Differences from the original:

- `HAPPIER_CODEX_APP_SERVER_*` env keys renamed to `HAPPY_CODEX_APP_SERVER_*` (matches `codexAppServerClient.ts` here)
- `@/testkit/env/envScope` dependency inlined as a ~25-line `createEnvKeyScope` helper in `fakeCodexAppServer.ts` — happy-cli does not have (and does not need) a shared env-scope testkit yet
- Scope API exposes `{ save(), restore() }` instead of happier's `{ patch(), restore() }` — happy-cli call sites only ever snapshot-and-restore, never patch
- `writeFakeCodexAppServerThreadListScript` is intentionally not ported — happy-cli does not consume `thread/list`

## Windows: `.mjs` is not directly invokable

`codexAppServerClient.ts` spawns the binary via `cmd.exe /d /s /c "<bin> ..."` (see `buildWindowsSpawnArgs`). On Windows, `cmd.exe` has no association for `.mjs` (`assoc .mjs` → "File association not found"), so pointing `HAPPY_CODEX_APP_SERVER_BIN` at a `.mjs` directly fails silently. The fix is a one-line `.cmd` shim next to the script, same shape npm uses for its CLI bin entries:

```
@echo off
node "<absolute-path-to-mjs>" %*
```

`fakeCodexAppServer.smoke.test.ts` does this inline — copy the helper from there for any new Windows-targeted test. On POSIX the `.mjs` shebang is sufficient; no shim required.

## Future work: full fallback E2E is still blocked

The smoke test proves the testkit chain (env override → spawn → JSONRPC → notification routing) works. What it does NOT cover is the actual `runCodexWithAppServer` business logic — specifically the auto-rescue fallback flow added in commit `604a4238`:

```
[fake codex emits error willRetry:false] → shouldAutoRescue → autoRescueGate
  → runManualCompact → buildHeuristicSeed → push '继续' → next turn/start with seed
```

Writing that test is blocked by a hard dependency: `runCodexWithAppServer`'s first ~50 lines call `ApiClient.create() → getOrCreateMachine() → getOrCreateSession() → setupOfflineSession()`, all against a live happy-server. There is no injection seam between `opts.credentials` and these calls.

After two test-writing attempts (Wave 2 Part 2 and Wave 3 Path X), the verified conclusion is that **Option B is the only clean unblock** — Path A (local dev server) and Path X (real production server with the user's own credentials) both hit the same architectural wall that B resolves.

| # | Option | Effort | Status |
|---|---|---|---|
| **A** | Bring up local dev happy-server (`HAPPY_SERVER_URL=http://localhost:3005`) + provision `~/.happy-dev-test/access.key` via `happy auth login`. Then use `describe.skipIf(!await isServerHealthy())`. | Originally estimated ~1 h; on Windows actually 2–8 h (Docker Desktop + Postgres + Redis + Prisma migrate + fixing `lsof` incompatibility in `yarn dev` script) | **Setup-blocked on Windows.** Even if started, both blockers below still apply. |
| **X** | Use the user's existing `~/.happy/access.key` against production `api.cluster-fluster.com`, opt-in via `HAPPY_TEST_REAL_SERVER=1` (mirrors `HAPPY_TEST_REAL_CODEX=1`). | Estimated 1–1.5 h; actually impossible in current architecture (verified Wave 3) | **Architecturally blocked.** See "Two architectural walls" below. |
| **B** | Refactor `runCodexWithAppServer` to accept `opts.deps?: { apiClient?, sessionFactory? }`. Production callers pass nothing. Tests construct an ApiClient + ApiSessionClient. **Not a mock framework** — a deps object IS production. Resolves BOTH walls in one stroke (test owns lifecycle AND can `injectPendingMessage()` directly via `apiSession.ts:228-234`, which already exists for restore). | ~3–4 h refactor + ~1.5–2 h test = **~5 h total** | **Only viable path forward.** Requires architectural sign-off. |
| **C** | `vi.mock('@/api/api', ...)`. Violates `packages/happy-cli/CLAUDE.md` rule ("No mocking — tests make real API calls"). | ~30 min | **Not recommended** — rule erosion. |

### Two architectural walls (why Path A and Path X both fail)

1. **No exit signal reachable from outside the closure.** `runCodexWithAppServer` has four shutdown surfaces, none usable from test code:
   - Ink Ctrl-C (`runCodexAppServer.ts:704-708`) — needs real TTY raw-mode stdin
   - `handleKillSession` (`L939-968`) — calls `process.exit(0)`, killing vitest worker
   - `registerShutdownHandlers` SIGTERM/SIGINT — Windows `process.kill` uses `TerminateProcess` and **does not run handlers** (see `shutdownHandlers.ts:11`)
   - `messageQueue.close()` — only callable from inside the runtime's closure

2. **No user-message send path from outside.** `session.onUserMessage` is the only entry to the turn loop, but `ApiSessionClient` exposes no external send-user-message helper. A test would have to reconstruct happy-app's encrypted `socket.emit('message', ...)` shape (`sync.ts:209-287`) — ~150 lines of duplicated encryption + normalize-message infrastructure, since `happy-agent` is not a happy-cli dependency.

Both walls dissolve under Option B: the test owns its own `ApiSessionClient` and uses `injectPendingMessage()` to push messages, and owns the lifecycle directly so the runtime can return naturally after `messageQueue.close()`.

Until one of these is chosen, the auto-rescue fallback chain (`runManualCompact` → `push '继续'`) is covered only by:

- AST contracts (`autoResumeAfterFallback.test.ts`, 9 cases) — prove the source code shape is correct, but cannot catch behavioural bugs that leave the AST intact (e.g. an `await` race that loses the seed)
- `shouldAutoRescue` real-shape fixtures (`codexAutoRescue.test.ts`) — cover the classification function in isolation, do not observe the runtime push
- The smoke test in this directory — proves the testkit is usable, does not invoke `runCodexWithAppServer`

The behavioural gap is real. The test that would close it is ~250 lines once Option A or B is unblocked.
