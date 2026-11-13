# context-mode — MANDATORY routing rules

You have context-mode MCP tools available. These rules are NOT optional — they protect your context window from flooding. A single unrouted command can dump 56 KB into context and waste the entire session.

## BLOCKED commands — do NOT attempt these

### curl / wget — BLOCKED
Any Bash command containing `curl` or `wget` is intercepted and replaced with an error message. Do NOT retry.
Instead use:
- `ctx_fetch_and_index(url, source)` to fetch and index web pages
- `ctx_execute(language: "javascript", code: "const r = await fetch(...)")` to run HTTP calls in sandbox

### Inline HTTP — BLOCKED
Any Bash command containing `fetch('http`, `requests.get(`, `requests.post(`, `http.get(`, or `http.request(` is intercepted and replaced with an error message. Do NOT retry with Bash.
Instead use:
- `ctx_execute(language, code)` to run HTTP calls in sandbox — only stdout enters context

### WebFetch — BLOCKED
WebFetch calls are denied entirely. The URL is extracted and you are told to use `ctx_fetch_and_index` instead.
Instead use:
- `ctx_fetch_and_index(url, source)` then `ctx_search(queries)` to query the indexed content

## REDIRECTED tools — use sandbox equivalents

### Bash (>20 lines output)
Bash is ONLY for: `git`, `mkdir`, `rm`, `mv`, `cd`, `ls`, `npm install`, `pip install`, and other short-output commands.
For everything else, use:
- `ctx_batch_execute(commands, queries)` — run multiple commands + search in ONE call
- `ctx_execute(language: "shell", code: "...")` — run in sandbox, only stdout enters context

### Read (for analysis)
If you are reading a file to **Edit** it → Read is correct (Edit needs content in context).
If you are reading to **analyze, explore, or summarize** → use `ctx_execute_file(path, language, code)` instead. Only your printed summary enters context. The raw file content stays in the sandbox.

### Grep (large results)
Grep results can flood context. Use `ctx_execute(language: "shell", code: "grep ...")` to run searches in sandbox. Only your printed summary enters context.

## Tool selection hierarchy

1. **GATHER**: `ctx_batch_execute(commands, queries)` — Primary tool. Runs all commands, auto-indexes output, returns search results. ONE call replaces 30+ individual calls.
2. **FOLLOW-UP**: `ctx_search(queries: ["q1", "q2", ...])` — Query indexed content. Pass ALL questions as array in ONE call.
3. **PROCESSING**: `ctx_execute(language, code)` | `ctx_execute_file(path, language, code)` — Sandbox execution. Only stdout enters context.
4. **WEB**: `ctx_fetch_and_index(url, source)` then `ctx_search(queries)` — Fetch, chunk, index, query. Raw HTML never enters context.
5. **INDEX**: `ctx_index(content, source)` — Store content in FTS5 knowledge base for later search.

## Subagent routing

When spawning subagents (Agent/Task tool), the routing block is automatically injected into their prompt. Bash-type subagents are upgraded to general-purpose so they have access to MCP tools. You do NOT need to manually instruct subagents about context-mode.

## Output constraints

- Keep responses under 500 words.
- Write artifacts (code, configs, PRDs) to FILES — never return them as inline text. Return only: file path + 1-line description.
- When indexing content, use descriptive source labels so others can `ctx_search(source: "label")` later.

## Windows symlink/junction rules

On Windows, Git Bash `ln -s` creates a **copy**, not a real symlink. You MUST use PowerShell for filesystem links:

- **Directory links** → use Junction (no admin required):
  ```powershell
  powershell.exe -Command "New-Item -ItemType Junction -Path '<link>' -Target '<target>'"
  ```
- **File symlinks** → require admin or Developer Mode enabled. Fall back to copy if unavailable:
  ```powershell
  powershell.exe -Command "New-Item -ItemType SymbolicLink -Path '<link>' -Target '<target>'"
  ```
- When iterating in bash loops, do NOT embed `$bash_var` inside PowerShell `-Command` strings — the variable won't expand. Build the full path string in bash first, then pass literal paths to PowerShell.

## ctx commands

| Command | Action |
|---------|--------|
| `ctx stats` | Call the `ctx_stats` MCP tool and display the full output verbatim |
| `ctx doctor` | Call the `ctx_doctor` MCP tool, run the returned shell command, display as checklist |
| `ctx upgrade` | Call the `ctx_upgrade` MCP tool, run the returned shell command, display as checklist |

## Debugging Codex/Claude CLI Sessions

- CLI logs: `~/.happy/logs/YYYY-MM-DD-HH-MM-SS-pid-NNNN.log` (daemon suffix `-daemon.log`)
- Look at log evidence BEFORE modifying code — one build/test cycle is expensive; cover all branches with diagnostic `logger.debug` dumps in a single pass
- Validate envelopes against app schema: write a temp `sources/xxx-temp.ts` under `packages/happy-app/`, call `RawRecordSchema.safeParse()` / `normalizeRawMessage()` / `reducer()`, run with `npx tsx`, delete after
- Reference impl for codex app-server migration: `E:/happy-claude/workspace/happier/apps/cli/src/backends/codex/appServer/`

## 新 Codex 账号：使用前先完成索引初始化

用户持续要求：新增或发现尚未初始化的 Happy Codex 账号时，先执行本节流程，再用于 App 聊天；无需重复询问是否修复索引。这是智能体执行规则，不表示登录程序已自动实现此流程。

1. 检查 `~/.happy/auth/codex/instances/<账号>/` 的认证文件、共享 `sessions` 链接和当前版本的会话索引。已完成初始化的正常账号跳过；`state_5.sqlite` 缺失或 `backfill_state.status` 未完成的新账号须先处理。历史故障：首次回填共享历史超过 Happy 的 15 秒初始化时限，导致 App 无法聊天；不能仅凭认证成功判定账号可用。
2. 对已确认空闲的新账号，复用同一共享历史、同一数据库迁移版本与 checksum、已由原生 Codex 完成回填的索引，通过 SQLite backup API 建立账号独立数据库。核对所有 rollout 文件存在且属于该共享目录，规范化路径；核对源库没有账号专属注册、外部配置导入等不能复制的记录。保留目标已有索引及 WAL/SHM，确认源快照涵盖目标已有线程后再安装。仅修复缺失或未完成的索引，禁止覆盖正常库、操作占用中的库，或直接链接其他账号的数据库。
3. 数据库版本、源库或路径不满足上述条件时，使用当前 Codex 的原生初始化流程并定位实际阻塞；禁止强写 `backfill_state=complete`、绕过迁移检查或照搬旧版本快照。不改认证文件、共享配置、全局账号选择，不重启其他会话。
4. 修复后逐账号验证 `quick_check=ok`、外键检查无错误、回填完成、数据库独立；通过真实 `codex app-server` 验证初始化在 Happy 时限内、账号认证有效，并在专用测试会话收到真实模型回复。批量新增账号须顺序恢复同一测试会话，验证跨账号续聊；测试不使用工具、不修改业务文件，结束后关闭本次测试进程。未直接测试手机界面时如实说明。

已验证流程、一次性脚本参考及原始备份：`~/.happy/incidents/account-index-recovery-20260919-0918/`。参考脚本在 `scripts/` 下；它们绑定本次四个账号，**不能原样用于后续账号**。后续执行须按当前账号、Codex 版本和源库生成新的运行副本，临时文件放在 `/private/tmp/xc-disposable/` 的唯一子目录，原始备份保存在新的持久 incident 目录。

## 统一 Git 提交边界

本项目遵循用户目录的统一 Git 内容规则：只提交源代码、配置、测试、文档、源素材、依赖清单/锁文件和可重建脚本；下载/安装软件、SDK/运行库/插件/模型、编译与发布产物、压缩包、缓存、日志、截图录像、会话/数据库、备份和任何凭据都不入 Git。提交前运行 `npm run check:git-policy`，查看暂存路径，禁止使用 `git add .`。Happy、AionUi、Codex 和 Claude 在本项目根目录工作时都必须遵守这条边界。
