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

## Daemon Logs
- Daemon logs are stored in `~/.happy-dev/logs/` (or `$HAPPY_HOME_DIR/logs/`)
- Named with format: `YYYY-MM-DD-HH-MM-SS-daemon.log`

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