# Codex BangCommand 支持方案

## 背景

BangCommand（`!login` `!auth` `!help` `!usage` 等）此前仅在 Claude 运行时可用。Codex 和 Gemini 模式下用户输入 `!` 命令会被直接当作 prompt 发送给模型。本方案将 BangCommand 扩展为跨 agent 的基础能力。

## 已验证结论

**CODEX_HOME 目录隔离可行**（2026-04-10 验证通过）

- 通过 `CODEX_HOME` 环境变量指定不同目录，可以同时运行多个 codex 实例，各自使用独立的 `auth.json`
- Codex CLI 在启动时读取 `$CODEX_HOME/auth.json`，未登录时会提示 `codex login`
- 目录布局与 CCS 为 Claude 创建的 `~/.ccs/instances/<profile>/` 模式对称
- **注意**：Windows 上 `CODEX_HOME` 必须使用 Windows 风格路径（`C:\...`），MSYS 路径（`/c/...`）会被 codex 拒绝

## 已完成的工作

### 1. BangCommand 类型解耦（types.ts）

- 移除 `BangCommandContext.session` 对 `@/claude/session` 的强依赖
- 引入 `BangSessionLike` 结构类型，仅暴露 handler 实际使用的字段（`mode`）
- 新增 `flavor?: 'claude' | 'codex' | 'gemini'` 字段，支持 handler 按 agent 分支

### 2. runCodex 接入 BangCommand 拦截（runCodex.ts）

- 在 `session.onUserMessage` 回调中、`messageQueue.push` 之前插入两道拦截：
  - `hasActiveInteractiveSession()` → 路由到 OAuth 子流程
  - `isBangCommand(text)` → 调用 `executeBangCommand`，结果推送到移动端
- 构造 codex 专属的 `BangCommandContext`：`flavor: 'codex'`、`session: { mode: 'remote' }`
- `restart-session` action 暂以提示兜底，待后续实现 codex MCP 子进程重启

### 3. Codex 目录隔离方案（ccsProfiles.ts）

- 新增 `AuthFlavor` 类型：`'claude' | 'codex' | 'gemini'`
- 新增 `getCodexInstancePath(profileName)`：`<happyHomeDir>/codex-instances/<sanitized-name>/`
- 新增 `hasCodexAuth(profileName)`：检查目标 profile 是否有 codex auth.json
- 新增 `getCurrentCodexProfile()`：从 `CODEX_HOME` 反推当前 profile
- 新增 `getCurrentProfileForFlavor(flavor)`：统一入口
- 新增 `applyProfileSwitch(name, flavor, claudeInstancePath?)`：按 flavor 设置 `CLAUDE_CONFIG_DIR` 或 `CODEX_HOME`
- 路径解析对齐 `configuration.ts`（`HAPPY_HOME_DIR` + `~` 展开，默认 `~/.happy`）

### 4. Auth 切换 flavor 化（authCommand.ts）

- 提取 `resolveAuthFlavor(ctx)` 统一 flavor 解析
- `listProfiles` / `switchProfile` / `switchAllProfiles` / `tryGlobalProfileSwitch` / `getProfileStatus` 全部按 flavor 分支
- codex 检查 `hasCodexAuth()`，claude 检查 `readOAuthToken()`

### 5. !login codex OAuth 流程（loginCommand.ts）

- 提取 `findCliBinary(name)` 通用 CLI 探测函数，`findClaudeCli` / `findCodexCli` 复用
- 新增 `analyzeCodexPtyOutput()`：检测 `auth.openai.com` OAuth URL、登录成功/失败
- 新增 `performCodexLogin()`：完整 codex 登录流程
  1. 创建 codex 实例目录
  2. 从当前 `CODEX_HOME` 复制 `config.toml` + `.env`
  3. Spawn `codex login` via PTY with `CODEX_HOME=<新目录>`
  4. 检测 OAuth URL → 推送到移动端
  5. Codex 浏览器 OAuth 回调自动完成 → 写入 auth.json
  6. 退出后注册 CCS profile
- 新增 `--codex` flag：`!login --codex myaccount` 在控制台或 claude 会话中强制走 codex 登录
- `handleLoginBangCommand` 按 `targetAgent`（flag > ctx.flavor > 'claude'）分流

### 6. daemon CODEX_HOME 持久化（daemon/run.ts）

- 移除 `tmp.dirSync()` 临时目录，改用 `getCodexInstancePath(accountId)` 持久化目录
- 从 token JSON 中提取 `tokens.account_id` 作为实例名（fallback `'default'`）
- 修复旧代码 `fs.writeFile` 缺少 `await` 的 race condition bug
- 移除不再使用的 `tmp` 依赖

## 当前可用命令（Codex 模式下）

| 命令 | 状态 | 说明 |
|---|---|---|
| `!help` | ✅ 可用 | 与 Claude 共享同一份 SSoT |
| `!login` | ✅ 可用 | codex 会话自动走 codex 登录；控制台可用 `--codex` flag |
| `!auth` | ✅ 可用 | 按 flavor 分支，codex 切 CODEX_HOME |
| `!auth-all` | ✅ 可用 | 广播切换 |
| `!usage` | ⚠️ 部分 | 查的是 Claude 用量，codex 用量待接入 |
| `!restart` | ⚠️ 兜底 | 返回提示信息，实际重启待实现 |
| `!session` / `!open` | ✅ 可用 | console-only，codex 不会走到 |

## 待完成工作

### P1 — !restart codex MCP 子进程重启

**问题**：`!restart` 返回 `action: 'restart-session'`，但 runCodex 不处理该 action。

**需要**：
- 调用 `client.storeSessionForResume()` 保存 codex session 状态
- `abortController.abort()` 中断当前 MCP 通信
- 销毁 `CodexMcpClient` 实例
- 创建新的 `CodexMcpClient`（继承更新后的 `CODEX_HOME`）
- 用 `experimental_resume` 恢复上下文

**影响范围**：runCodex.ts

### P1 — daemon 无 token 时的 CODEX_HOME 缺口

**问题**：app 远程启动 codex 会话时，如果只传 `agent: 'codex'`（无 `token`、无 `environmentVariables.CODEX_HOME`），daemon 不会设置 `CODEX_HOME`，codex 回退到全局 `~/.codex`。导致：
1. 所有无 token 的 codex 会话共享全局 auth
2. `!auth` 切换的 `CODEX_HOME` 不会影响这些会话
3. 多个 codex 会话无法同时用不同账号

**三条 CODEX_HOME 路径**：
| 场景 | CODEX_HOME | 状态 |
|---|---|---|
| app 传了 `token` | `~/.happy/codex-instances/<account_id>/` | ✅ 已对齐 |
| app 传了 `environmentVariables.CODEX_HOME` | 用户指定的路径 | ✅ 直传 |
| app 只传了 `agent: 'codex'` | 未设置 → 回退 `~/.codex` | ⚠️ 缺口 |

**建议方案**：daemon 在 `agent === 'codex'` 且 `extraEnv` 不含 `CODEX_HOME` 时，继承当前 `process.env.CODEX_HOME`（如果有）或设置为 `getCodexInstancePath('default')`。

**影响范围**：daemon/run.ts

### P2 — codex welcome 消息

**问题**：Claude 有 `buildSessionWelcome` / `buildConsoleWelcome` 注入，codex 启动后没有引导消息。

**需要**：runCodex 在 `session.waitForConnect()` 后注入一次 welcome 消息。

### P2 — !usage codex 用量查询

**问题**：当前 `!usage` 查的是 Anthropic API 的 Claude 用量。Codex 用量需要查 `chatgpt.com/backend-api/wham/usage`。

**需要**：usageCommand.ts 按 flavor 分支，codex 走 OpenAI 用量接口。

### P3 — AgentRuntime 抽象统一

**长期**：将 `Session`（Claude）、codex MCP client、gemini client 抽象为 `AgentRuntime` 接口，让 BangCommandContext 持有 `AgentRuntime` 而非具体类型。dispatcher、restart、welcome 全部走抽象层。

## 文件变更清单

| 文件 | 类型 |
|---|---|
| `packages/happy-cli/src/commands/bang/types.ts` | 修改 |
| `packages/happy-cli/src/commands/bang/ccsProfiles.ts` | 修改 |
| `packages/happy-cli/src/commands/bang/authCommand.ts` | 修改 |
| `packages/happy-cli/src/commands/bang/loginCommand.ts` | 修改 |
| `packages/happy-cli/src/codex/runCodex.ts` | 修改 |
| `packages/happy-cli/src/daemon/run.ts` | 修改 |

## 验证状态

- TypeScript 编译：✅ 0 errors
- 单元测试：✅ 84/84 passed
- CODEX_HOME 目录隔离：✅ 验证通过（两个实例可并行运行）
- `codex login` PTY 输出分析：✅ 4/4 场景通过（URL提取、成功、错误、部分输出）
- `codex login` 实际运行：✅ 验证 OAuth URL 正确输出（Windows 路径兼容）
