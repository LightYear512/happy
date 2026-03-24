# Happy

Code on the go — control AI coding agents from your mobile device.

Free. Open source. Code anywhere.

## Installation

### 1. Install CCS (Claude Code Supervisor)

Happy uses [CCS](https://www.npmjs.com/package/@kaitranntt/ccs) to manage Claude Code authentication profiles. Install it first:

```bash
npm install -g @kaitranntt/ccs
```

### 2. Create a CCS account

```bash
ccs auth create <profile-name>
```

This creates a profile at `~/.ccs/instances/<profile-name>/` with OAuth credentials. You can create multiple profiles (e.g. `work`, `personal`) and switch between them.

### 3. Install Happy CLI

```bash
npm install -g https://github.com/LightYear512/happy/releases/download/v0.13.0-compat.2/happy-coder-0.13.0-compat.2.tgz
```

## Run From Source

From a repo checkout:

```bash
# repository root
yarn cli --help

# package directory
yarn cli --help
```

## Usage

### Claude (default)

```bash
happy
```

This will:
1. Start a Claude Code session
2. Display a QR code to connect from your mobile device
3. Allow real-time session sharing between Claude Code and your mobile app

### Gemini

```bash
happy gemini
```

Start a Gemini CLI session with remote control capabilities.

**First time setup:**
```bash
# Authenticate with Google
happy connect gemini
```

## Commands

### Main Commands

- `happy` – Start Claude Code session (default)
- `happy gemini` – Start Gemini CLI session
- `happy codex` – Start Codex mode
- `happy acp` – Start a generic ACP-compatible agent

### Utility Commands

- `happy auth` – Manage authentication
- `happy connect` – Store AI vendor API keys in Happy cloud
- `happy sandbox` – Configure sandbox runtime restrictions
- `happy notify` – Send a push notification to your devices
- `happy daemon` – Manage background service
- `happy doctor` – System diagnostics & troubleshooting
- `happy logout` – Log out and clear stored credentials

### Connect Subcommands

```bash
happy connect gemini     # Authenticate with Google for Gemini
happy connect claude     # Authenticate with Anthropic
happy connect codex      # Authenticate with OpenAI
happy connect status     # Show connection status for all vendors
```

### Gemini Subcommands

```bash
happy gemini                      # Start Gemini session
happy gemini model set <model>    # Set default model
happy gemini model get            # Show current model
happy gemini project set <id>     # Set Google Cloud Project ID (for Workspace accounts)
happy gemini project get          # Show current Google Cloud Project ID
```

**Available models:** `gemini-2.5-pro`, `gemini-2.5-flash`, `gemini-2.5-flash-lite`

### Generic ACP Commands

```bash
happy acp gemini                     # Run built-in Gemini ACP command
happy acp opencode                   # Run built-in OpenCode ACP command
happy acp opencode --verbose         # Include raw backend/envelope logs
happy acp -- custom-agent --flag     # Run any ACP-compatible command directly
```

### Sandbox Subcommands

```bash
happy sandbox configure  # Interactive sandbox setup wizard
happy sandbox status     # Show current sandbox configuration
happy sandbox disable    # Disable sandboxing
```

## Options

### Claude Options

- `-m, --model <model>` - Claude model to use (default: sonnet)
- `-p, --permission-mode <mode>` - Permission mode: auto, default, or plan
- `--profile <name>` - Use a specific CCS profile (overrides default)
- `--claude-env KEY=VALUE` - Set environment variable for Claude Code
- `--claude-arg ARG` - Pass additional argument to Claude CLI

### Global Options

- `-h, --help` - Show help
- `-v, --version` - Show version
- `--no-sandbox` - Disable sandbox for the current Claude/Codex run

## Console Commands (Bang Commands)

When inside a Happy session, you can use bang commands to manage sessions and profiles:

### Session Management

- `!open` – List all sessions with quick-resume buttons
- `!open <id>` – Resume a specific session (aliases: `!o`, `!r`)
- `!session` – List recent project directories
- `!session <dir>` – List sessions under a specific directory

### Profile Switching

- `!auth` – List available CCS profiles for the current session
- `!auth <name>` – Switch current session to a different CCS profile

### Console-Only Commands

These commands are only available in the console (multi-session) mode:

- `!auth-all <name>` – Switch all sessions on this machine to a CCS profile
- `!restart-all` – Restart all sessions

## MCP Server

Happy CLI includes an MCP (Model Context Protocol) server (`happy-mcp`) that acts as a bridge for AI agents (Codex, Gemini, ACP). It is invoked automatically when running `happy codex`, `happy gemini`, or `happy acp` — no manual setup required.

## Environment Variables

### Happy Configuration

- `HAPPY_SERVER_URL` - Custom server URL (default: https://api.cluster-fluster.com)
- `HAPPY_WEBAPP_URL` - Custom web app URL (default: https://app.happy.engineering)
- `HAPPY_HOME_DIR` - Custom home directory for Happy data (default: ~/.happy)
- `HAPPY_DISABLE_CAFFEINATE` - Disable macOS sleep prevention (set to `true`, `1`, or `yes`)
- `HAPPY_EXPERIMENTAL` - Enable experimental features (set to `true`, `1`, or `yes`)

### Gemini Configuration

- `GEMINI_MODEL` - Override default Gemini model
- `GOOGLE_CLOUD_PROJECT` - Google Cloud Project ID (required for Workspace accounts)

## Gemini Authentication

### Personal Google Account

Personal Gmail accounts work out of the box:

```bash
happy connect gemini
happy gemini
```

### Google Workspace Account

Google Workspace (organization) accounts require a Google Cloud Project:

1. Create a project in [Google Cloud Console](https://console.cloud.google.com/)
2. Enable the Gemini API
3. Set the project ID:

```bash
happy gemini project set your-project-id
```

Or use environment variable:
```bash
GOOGLE_CLOUD_PROJECT=your-project-id happy gemini
```

**Guide:** https://goo.gle/gemini-cli-auth-docs#workspace-gca

## Contributing

Interested in contributing? See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup and guidelines.

## Requirements

- Node.js >= 20.0.0
- [CCS](https://www.npmjs.com/package/@kaitranntt/ccs) installed with at least one profile (`ccs auth create <name>`)

### For Claude

- Claude CLI installed & logged in (`claude` command available in PATH)

### For Gemini

- Gemini CLI installed (`npm install -g @google/gemini-cli`)
- Google account authenticated via `happy connect gemini`

## License

MIT
