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
