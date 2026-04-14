# Happy CLI Codebase Overview

## Project Overview

Happy CLI (`handy-cli`) is a command-line tool that wraps Claude Code to enable remote control and session sharing. It's part of a three-component system:

1. **handy-cli** (this project) - CLI wrapper for Claude Code
2. **handy** - React Native mobile client
3. **handy-server** - Node.js server with Prisma (hosted at https://api.happy-servers.com/)

## Code Style Preferences

### TypeScript Conventions
- **Strict typing**: No untyped code ("I despise untyped code")
- **Clean function signatures**: Explicit parameter and return types
- **As little as possible classes**
- **Comprehensive JSDoc comments**: Each file includes header comments explaining responsibilities.
- **Import style**: Uses `@/` alias for src imports, e.g., `import { logger } from '@/ui/logger'`
- **File extensions**: Uses `.ts` for TypeScript files
- **Export style**: Named exports preferred, with occasional default exports for main functions

### DO NOT

- Create stupid small functions / getters / setters
- Excessive use of `if` statements - especially if you can avoid control flow changes with a better design
- **NEVER import modules mid-code** - ALL imports must be at the top of the file

### Error Handling
- Graceful error handling with proper error messages
- Use of `try-catch` blocks with specific error logging
- Abort controllers for cancellable operations
- Careful handling of process lifecycle and cleanup

### Testing
- Unit tests using Vitest
- No mocking - tests make real API calls
- Test files colocated with source files (`.test.ts`)
- Descriptive test names and proper async handling

### Logging
- All debugging through file logs to avoid disturbing Claude sessions
- Console output only for user-facing messages
- Special handling for large JSON objects with truncation

## Architecture & Key Components

### 1. API Module (`/src/api/`)
Handles server communication and encryption.

- **`api.ts`**: Main API client class for session management
- **`apiSession.ts`**: WebSocket-based real-time session client with RPC support
- **`auth.ts`**: Authentication flow using TweetNaCl for cryptographic signatures
- **`encryption.ts`**: End-to-end encryption utilities using TweetNaCl
- **`types.ts`**: Zod schemas for type-safe API communication

**Key Features:**
- End-to-end encryption for all communications
- Socket.IO for real-time messaging
- Optimistic concurrency control for state updates
- RPC handler registration for remote procedure calls

### 2. Claude Integration (`/src/claude/`)
Core Claude Code integration layer.

- **`loop.ts`**: Main control loop managing interactive/remote modes
- **`types.ts`**: Claude message type definitions with parsers

- **`claudeSdk.ts`**: Direct SDK integration using `@anthropic-ai/claude-code`
- **`interactive.ts`**: **LIKELY WILL BE DEPRECATED in favor of running through SDK** PTY-based interactive Claude sessions
- **`watcher.ts`**: File system watcher for Claude session files (for interactive mode snooping)

- **`mcp/startPermissionServer.ts`**: MCP (Model Context Protocol) permission server

**Key Features:**
- Dual mode operation: interactive (terminal) and remote (mobile control)
- Session persistence and resumption
- Real-time message streaming
- Permission intercepting via MCP [Permission checking not implemented yet]

### 3. UI Module (`/src/ui/`)
User interface components.

- **`logger.ts`**: Centralized logging system with file output
- **`qrcode.ts`**: QR code generation for mobile authentication
- **`start.ts`**: Main application startup and orchestration

**Key Features:**
- Clean console UI with chalk styling
- QR code display for easy mobile connection
- Graceful mode switching between interactive and remote

### 4. Core Files

- **`index.ts`**: CLI entry point with argument parsing
- **`persistence.ts`**: Local storage for settings and keys
- **`utils/time.ts`**: Exponential backoff utilities

## Data Flow

1. **Authentication**: 
   - Generate/load secret key → Create signature challenge → Get auth token

2. **Session Creation**:
   - Create encrypted session with server → Establish WebSocket connection

3. **Message Flow**:
   - Interactive mode: User input → PTY → Claude → File watcher → Server
   - Remote mode: Mobile app → Server → Claude SDK → Server → Mobile app

4. **Permission Handling**:
   - Claude requests permission → MCP server intercepts → Sends to mobile → Mobile responds → MCP approves/denies

## Key Design Decisions

1. **File-based logging**: Prevents interference with Claude's terminal UI
2. **Dual Claude integration**: Process spawning for interactive, SDK for remote
3. **End-to-end encryption**: All data encrypted before leaving the device
4. **Session persistence**: Allows resuming sessions across restarts
5. **Optimistic concurrency**: Handles distributed state updates gracefully

## Security Considerations

- Private keys stored in `~/.handy/access.key` with restricted permissions
- All communications encrypted using TweetNaCl
- Challenge-response authentication prevents replay attacks
- Session isolation through unique session IDs

## Dependencies

- Core: Node.js, TypeScript
- Claude: `@anthropic-ai/claude-code` SDK
- Networking: Socket.IO client, Axios
- Crypto: TweetNaCl
- Terminal: node-pty, chalk, qrcode-terminal
- Validation: Zod
- Testing: Vitest 


# Running the Daemon

## Starting the Daemon
```bash
# From the happy-cli directory:
./bin/happy.mjs daemon start

# With custom server URL (for local development):
HAPPY_SERVER_URL=http://localhost:3005 ./bin/happy.mjs daemon start

# Stop the daemon:
./bin/happy.mjs daemon stop

# Check daemon status:
./bin/happy.mjs daemon status
```

## Logs
- Stored in `~/.happy/logs/` (or `$HAPPY_HOME_DIR/logs/`)
- CLI process: `YYYY-MM-DD-HH-MM-SS-pid-NNNN.log`
- Daemon: `YYYY-MM-DD-HH-MM-SS-pid-NNNN-daemon.log`

# Testing

- `npx vitest run <path>` — 单文件测试（必须带 `run`，否则进 watch 模式卡死）
- 调试 interactive CLI：node-pty spawn + `CODEX_HOME=/tmp/xxx` + setTimeout kill，用 `JSON.stringify(output)` 保留 ANSI 方便写回放用例
- Windows node-pty 会打印 `AttachConsole failed` 警告，无害，不影响 PTY 捕获

# PTY Output Parsing (loginCommand.ts)

- `stripTerminalOutput(buf)` → cursor-positioning escapes 变 `\n`，适合**短 URL / 按行识别关键词**（防止贪婪正则吞入下一行 TUI 文本）
- `stripAnsiOnly(buf)` → ANSI 全删但不加空白，适合**长 URL 跨 PTY 换行拼接**（Claude `/oauth/authorize` 在 80/120 列被拆）
- Codex device-auth URL 短（`auth.openai.com/codex/device`），用前者；Claude OAuth URL 长，用后者

# Codex CLI Gotchas

- `codex login --device-auth`（0.118+）输出：URL `https://auth.openai.com/codex/device` + 独立行 `[A-Z0-9]{4}-[A-Z0-9]{4,6}` 一次性 code，15 分钟有效
- Device-auth 需用户先在 ChatGPT Security settings 启用；未启用时 codex 回退到 localhost:1455 浏览器回调，headless 环境会挂
- `codex login --help` 可快速确认当前版本是否支持 `--device-auth`

# Bang Commands & Auth Profiles

- Claude profiles live at `~/.ccs/instances/<name>/` (managed by external CCS, **not** under `$HAPPY_HOME_DIR`)
- Codex profiles live at `<happyHomeDir>/auth/codex/instances/<name>/` (the old `codex-instances/` path is dead — `docs/codex-bangcommand-support.md` still references it, treat as stale)
- Console sessions (`isConsoleSession=true`) are not launched via `ccs`, so `CLAUDE_CONFIG_DIR`/`CODEX_HOME` are never set → `getCurrentProfileForFlavor()` always returns `null` in console. Branches that depend on a "current profile" must guard `if (isConsole)` first, before any `if (!currentProfile)` fallback

# Codex Backends

Happy CLI supports two codex backends selected by `HAPPY_CODEX_BACKEND_MODE`:
- `appServer` (default when codex available) — `codex app-server` JSONRPC over stdio, true session resume via `thread/resume`
- `mcp` — `codex mcp-server` (legacy, `experimental_resume` only, partial context injection)

Key files: `src/codex/runCodexAppServer.ts`, `src/codex/codexAppServerClient.ts`, `src/codex/appServerStreamBridge.ts`. Reference impl: `../../../happier/apps/cli/src/backends/codex/appServer/`.

## App-Server Protocol Gotchas
- `turn/start` RPC is **non-blocking** — returns immediately with turnId; await `turn/completed` notification via pending-turn promise
- `approvalPolicy` must be `{granular: {mcp_elicitations, rules, sandbox_approval}}` — string values wait for TUI approval and hang headless sessions
- `sandboxPolicy` is a tagged enum object `{type: 'workspaceWrite', writableRoots, ...}`, not a string
- MCP elicitation response format: `{action: 'accept', content: {}}` (not `{decision}`)
- Config overrides use `-c key=value` CLI args, not `--config` or `--config-override`
- Windows `.cmd` shim spawn needs `cmd.exe /d /s /c` wrapping + `escapeCmdArgument()` + `windowsVerbatimArguments: true`. Do NOT use `shell: true` — it mangles TOML array values in config overrides

# Claude `--resume` Behavior

## Current Behavior (Claude Code 2.x+)

`--resume <session-id>` **reuses the same Claude session ID**. It does NOT create a new session ID.

Only `compact` and `clear` operations generate a new Claude session ID. All other operations (including `--resume`) keep the original session ID.

### Session File Behavior
- `--resume` appends to the **same** `.jsonl` file: `~/.claude/projects/.../<session-id>.jsonl`
- No new session file is created
- Context is preserved as a continuous conversation

## Important: Claude sessionId vs happySessionId

These are two independent ID systems:

- **Claude sessionId**: Managed by Claude Code. Stable across `--resume`. Stored in `.jsonl` filename.
- **happySessionId**: Managed by happy-server. Created fresh every time `runClaude()` calls `api.getOrCreateSession({ tag: randomUUID() })`. Always new, even on `--resume`.

This means: when a session is resumed, the Claude sessionId stays the same, but the happySessionId is always different.