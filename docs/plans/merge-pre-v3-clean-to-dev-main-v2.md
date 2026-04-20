# 合并方案：compat/pre-v3-clean → dev-main-v2

> 日期：2026-04-10（2026-04-17 更新）
> 作者：xuhaodong
> 状态：**阶段 A/B/C 全部完成** — Resume 去重 + Session auto-restore 已落地

---

## 1. 分支现状

| 维度 | dev-main-v2 | compat/pre-v3-clean |
|------|-------------|---------------------|
| 基于 | upstream main (最新，已 rebase) | 较早的 merge base `3ed8b12` (2026-01-28) |
| 独有提交数 | 11 个（在 main 之上，含拆分后提交） | ~120+ 个 |
| 主要开发者 | xuhaodong, upstream | xuhaodong, layaboxma |
| 定位 | 主开发分支，跟踪 upstream | 兼容分支，包含大量独立功能 |

### dev-main-v2 独有提交（11 个）

```
27869301 feat: add --kill-sessions flag to daemon stop command        ← 阶段 B 已执行
71a5ae71 fix(mcp): add NO_PROXY for local MCP servers behind HTTP proxy  ← 阶段 A 已执行
02f31206 fix(cli): prevent outbox message loss on flush failure       ← 从 b851d7b4 拆分
a90de72d feat(cli): add workspace trust pre-write for Claude re-spawn ← 从 501e7271 拆分
f7171817 feat(cli): add flushOutbox diagnostics logging               ← 从 501e7271 拆分
8d5e9ced feat: add --profile flag and CCS default profile resolution at startup
24a2c879 feat: add !auth bang command for CCS profile switching
319a6e9e fix(app): remove duplicate purchasesSync invalidate on app resume  ← 从 b851d7b4 拆分
10375b4c chore(happy-app): add EAS build config, docs, and arm64 optimization
6bf1d3e8 feat(happy-app): improve server config and connection handling
e4c3abbe feat(happy-app): make GMS optional with ENABLE_GMS flag
```

---

## 2. 直接 merge 可行性

**结论：❌ 不可行**

### 冲突文件清单（40+ 个）

#### add/add 冲突（两边独立创建了同名文件，需完全重写解冲突）

| 文件 | 说明 |
|------|------|
| `packages/happy-agent/src/*.ts` (api, auth, index, output, session) | 整个包两边独立实现 |
| `packages/happy-agent/package.json`, `README.md`, `vitest.config.ts` | 包配置 |
| `docs/plans/happy-agent.md` | 设计文档 |
| `docs/session-protocol*.md` (4 个文件) | 协议文档 |
| `Dockerfile` | 容器配置 |
| `packages/happy-app/sources/components/modelModeOptions.*` | App 组件 |

#### content 冲突（同文件两边都修改了）

| 文件 | 说明 |
|------|------|
| `package.json` (根目录) | 依赖版本 |
| `Dockerfile.server`, `Dockerfile.webapp` | 容器优化 |
| `packages/happy-app/app.config.js` | App 配置 |
| `packages/happy-app/package.json` | App 依赖 |
| `packages/happy-app/sources/-session/SessionView.tsx` | 会话视图 |
| `packages/happy-app/sources/app/(app)/dev/index.tsx` | 开发页 |
| `packages/happy-app/sources/app/(app)/new/index.tsx` | 新建页 |
| `packages/happy-app/sources/app/_layout.tsx` | 布局 |
| `packages/happy-app/sources/components/AgentInput.tsx` | 输入组件 |
| `packages/happy-app/sources/components/MessageView.tsx` | 消息视图 |
| `.gitignore`, `docs/README.md` | 杂项 |

#### modify/delete 冲突（dev-main-v2 删除了 pre-v3-clean 修改的文件）

| 文件 | 说明 |
|------|------|
| `packages/happy-app/sources/app/(app)/new/pick/path.tsx` | dev-main-v2 已删除 |
| `packages/happy-app/sources/components/NewSessionWizard.tsx` | dev-main-v2 已删除 |
| `packages/happy-app/sources/components/ProfileEditForm.tsx` | dev-main-v2 已删除 |

---

## 3. pre-v3-clean 功能清单与分层

### 第一层：独立功能，无跨层依赖

这些提交可以安全 cherry-pick，不依赖服务端或数据库变更。

| 提交 | 功能 | 适用平台 | 建议 |
|------|------|---------|------|
| `26a2f3ed` | MCP proxy bypass（NO_PROXY 注入） | 全平台 | ✅ cherry-pick，有 upstream PR 价值 |
| `ea96d391` | 防止 ExitCodeError 覆盖 switch intent | 全平台 | ❌ **跳过** — upstream `20ec49ad` (PR #974) 已有等价修复且已在 main 中 |
| `54494c38` | McpServer per-request 避免 SDK 1.27+ 500 | 全平台 | ❌ **跳过** — upstream `0fd4112f` 已有等价修复且已在 main 中 |

### 第二层：CLI 侧闭环功能

这些功能仅修改 CLI 代码，不需要服务端配合，但改动面较大需仔细合入。

| 功能块 | 涉及提交 | 关键文件 | 建议 |
|--------|---------|---------|------|
| **--kill-sessions** | `b86eb732` | daemon/run.ts, controlServer.ts, controlClient.ts, index.ts | ✅ 手动 patch（改 requestShutdown 签名，必须最先移植） |
| **Resume 去重** | `2b9ca891`, `e83f0265` | daemon/run.ts, types.ts, controlServer.ts, apiMachine.ts, registerCommonHandlers.ts | ✅ 已完成（2026-04-17，手动 patch 落地，防幽灵进程，upstream #721） |
| **Smart error recovery** | `d9395294` | errorFormatter.ts, claudeRemoteLauncher.ts, runClaude.ts, usageCommand.ts, dispatcher.ts (7 files, +417/-37) | ❌ **延后** — 依赖链深：前置需 errorFormatter/usageCommand/ccsProfiles/loginCommand，当前 dev-main-v2 缺少 errorFormatter.ts |
| **Proxy bypass for !usage** | `592e34a7` | usageCommand.ts, format.ts | ❌ **跳过** — dev-main-v2 缺少 usageCommand.ts，与 smart error recovery 同属 bang 命令依赖集群 |

### 第三层：macOS 专用功能

当前开发机为 Windows，这些功能**暂不适用**。

| 功能块 | 涉及提交 | 说明 |
|--------|---------|------|
| macOS Keychain OAuth | `855ee299`, `6eefecee`, `47275749` | 读取 macOS Keychain 中的 OAuth token |
| node-pty spawn-helper 权限 | `7385d522`, `03d66705` | 修复 macOS 上 prebuild 丢失 +x |
| Login PTY 改进 | `d88960c0`, `ff52fee7`, `3f298db1`, `12c17566` | 主要在 macOS 测试验证 |

### 第四层：跨层耦合功能（需服务端 + CLI + DB 协调）

| 功能 | 涉及提交 | 涉及组件 | 依赖 |
|------|---------|---------|------|
| **Session auto-restore** | 核心提交 + DB 迁移 | Server sessionUpdateHandler + Daemon run.ts + CLI apiMachine + Prisma | 见下方详细分析 |
| **Console session 系列** | 多个提交 | CLI bang commands + Daemon | 部分依赖服务端会话模型 |

### 第五层：大型架构变更（不建议合入）

| 功能块 | 说明 | 建议 |
|--------|------|------|
| happy-agent 整包 | pre-v3-clean 有独立实现，dev-main-v2 也有（来自 upstream） | ❌ **不合入**，以 upstream 版本为准 |
| Session protocol 文档 | 设计文档系列 | ❌ **不合入**，架构已演进 |
| ACP runner/mapper | ACP 协议适配层 | ❌ **不合入**，跟踪 upstream |
| PGLite standalone server | 独立 binary + PGLite 嵌入 | ❌ **不合入**，Windows 不可用 |
| Docker 镜像优化 | 6.5GB → 1.89GB | ⚠️ 可后续独立评估 |

---

## 4. Session Auto-Restore 深度分析

### 架构

```
App 用户发消息给已关闭会话
        ↓
Server: sessionUpdateHandler.tryRestoreSession()
  - 检测会话状态（ZOMBIE_THRESHOLD=2min）
  - 获取 restoring lock（30s TTL 防重复）
  - 通过 plainMachineId 路由到正确的 daemon
  - 发射 'server-restore-session' socket 事件
        ↓
Daemon: run.ts 监听 'server-restore-session'
  - 读取 ~/.happy/restore/<sessionId>.json
  - spawn CLI with --resume 恢复 Claude 上下文
        ↓
CLI: apiMachine.ts
  - 发送明文 claudeSessionId/summary/machineId
  - Server 同步到 DB
```

### 数据库变更

| 迁移 | SQL | 安全性 |
|------|-----|--------|
| `20260327142704` | `ALTER TABLE "Session" ADD COLUMN "claudeSessionId" TEXT, ADD COLUMN "summary" TEXT;` | ✅ nullable，向后兼容 |
| `20260330070000` | `ALTER TABLE "Session" ADD COLUMN "plainMachineId" TEXT;` | ✅ nullable，向后兼容 |

Prisma schema 还增加了 `driverAdapters` preview feature（为 PGLite 支持，可选）。

**迁移安全性：完全安全。** 都是 nullable ADD COLUMN，不影响现有查询，即使迁移后不部署新代码也不会出错。

### 部署约束

| 场景 | 结果 |
|------|------|
| 只升级 Server，不升级 Daemon | Server 发出 `server-restore-session` 事件，Daemon 无监听→静默失败，用户无感知（不会崩溃，但功能不生效） |
| 只升级 Daemon，不升级 Server | Daemon 写了 restore file 但无人触发→无害 |
| 只迁移 DB | 新列无人读写→无害 |
| 三方同时升级 | ✅ 功能正常工作 |

**结论：必须 Server + Daemon + CLI + DB 同时部署才能生效，但部分部署不会导致崩溃。**

---

## 5. 服务端兼容性分析

### pre-v3-clean 修改的服务端文件

| 文件 | 改动类型 | 与 dev-main-v2 兼容性 |
|------|---------|---------------------|
| `prisma/schema.prisma` | 增加 3 列 + driverAdapters | ✅ 纯增量 |
| `prisma/migrations/` (2 个) | ADD COLUMN | ✅ 安全 |
| `sources/app/api/socket.ts` | 传 userRpcListeners 给 handler + 踢过期连接 | ⚠️ 需确认 socket.ts 当前版本 |
| `sources/app/api/socket/sessionUpdateHandler.ts` | 增加 tryRestoreSession + 参数变更 | ⚠️ 依赖 socket.ts 变更 |
| `sources/app/api/api.ts` | 未详 | 需检查 |
| `sources/app/api/routes/sessionRoutes.ts` | 未详 | 需检查 |
| `sources/app/presence/sessionCache.ts` | 未详 | 需检查 |
| `sources/main.ts` | 未详 | 需检查 |
| `sources/storage/db.ts` | driverAdapters / PGLite | ⚠️ dev-main-v2 不需要 |
| `sources/storage/files.ts`, `processImage.ts`, `uploadImage.ts` | 未详 | 需检查 |
| `sources/utils/log.ts` | 未详 | 需检查 |

### 关键接口变更

| 接口 | pre-v3-clean 变更 | 影响 |
|------|-------------------|------|
| `SpawnSessionResult` | 增加 `'superseded'` type | controlServer 需适配 |
| `requestShutdown` 签名 | `() => void` → `(options?: { stopSessions?: boolean }) => void` | controlServer + run.ts 需同步改 |
| `sessionUpdateHandler` 参数 | 增加 `userRpcListeners` 参数 | socket.ts 需同步改 |
| `TrackedSession` | 增加 `resumeTarget` 字段 | types.ts 需同步改 |

---

## 6. 推荐执行方案

### 阶段 A：~~立即执行~~ ✅ 已完成

1. **Cherry-pick `26a2f3ed`**（MCP proxy bypass）→ 已合入为 `71a5ae71`
   - Upstream PR 分支 `pr/mcp-proxy-bypass-upstream` 已打磨完成（含 `::1` IPv6 支持 + 10 个单元测试）
   - 待推送提 PR

### 阶段 B：~~手动 patch~~ 部分完成

移植顺序：`b86eb732` → `2b9ca891` → `e83f0265`（后者依赖前者的签名变更）

2. **~~手动移植 --kill-sessions~~**（`b86eb732`）→ ✅ 已合入为 `27869301`
   - 改 requestShutdown 签名，已完成
   - 涉及：controlClient.ts, controlServer.ts, run.ts, index.ts

3. **~~手动移植 resume 去重~~**（`2b9ca891` + `e83f0265`）→ ✅ 已完成（2026-04-17）
   - 已落地文件：daemon/run.ts, types.ts, controlServer.ts, apiMachine.ts, registerCommonHandlers.ts
   - 关键标记：`resumeTarget` 字段、`SessionAwaiter` 含 cancel、`'superseded'` type
   - 价值：防止幽灵进程，upstream #721

### 阶段 C：~~观望~~ ✅ 已完成（2026-04-17）

4. **Session auto-restore**
   - CLI ①：`api.ts` 增加 `createAccessKey()` + `runClaude.ts` 调用（写入 AccessKey 路由映射）
   - Server ②：`sessionUpdateHandler.ts` 增加 `tryRestoreSession()`（App 发消息→查 AccessKey→通过 socket 唤醒 daemon）
   - CLI ③：`apiMachine.ts` 监听 `session-restore-request`（unencrypted event，绕过 RPC 加密屏障）
   - P1 修复：`findFirst` 加 `orderBy: updatedAt desc`（多机场景）、`resumeSessionHandler` 调用加 try/catch
   - plan-review 评分 72/80 ⭐⭐⭐⭐⭐

### 阶段 D：部分完成（2026-04-17 盘点）

5. **Smart error recovery**（`d9395294`）— ⚠️ **部分落地，进行中**
   - ✅ `claudeRemoteLauncher.ts` 存在
   - ✅ `usageCommand.ts` 的 `queryRateLimitContext()`
   - ❌ `errorFormatter.ts`（`ErrorSeverity`/`recoverySteps`/`onRateLimitEvent`）— 待补
6. **Console session 系列** — ✅ **已完成**（`isConsoleSession` 在 runClaude/bang/dispatcher/authCommand 全面落地）
7. **macOS 专用修复** — ⏸ 保持延后（Windows 开发机不适用）
8. **Docker 镜像优化**（`92f0ed43`）— ✅ **已完成**（`Dockerfile` 已用 `node:20-slim`，6.5GB→1.89GB）

### 不执行

- `ea96d391`（ExitCodeError switch intent）— upstream `20ec49ad` (PR #974) 已有等价修复
- `54494c38`（McpServer per-request）— upstream `0fd4112f` 已有等价修复
- `592e34a7`（undici proxy for !usage）— 前置 usageCommand.ts 不存在
- happy-agent 整包 — 以 upstream 版本为准
- Session protocol 文档 — 架构已演进
- PGLite standalone — Windows 不可用
- Bang 命令重命名系列 — 大量文件改动且与 dev-main-v2 当前命名不兼容

---

## 7. Upstream PR 评估

| 提交 | PR 价值 | 状态 | 理由 |
|------|---------|------|------|
| `26a2f3ed` MCP proxy bypass | ✅ **推荐提 PR** | ✅ 已打磨 | upstream 无此修复，企业代理环境普遍受影响 |
| `02f31206` outbox flush fix | ✅ **推荐提 PR** | ⏳ 待打磨 | upstream `5a08be71` 有 data loss 风险，我们的修复更安全 |
| `54494c38` McpServer per-request | ❌ 不需要 | — | upstream `0fd4112f` 已有等价修复 |

### `26a2f3ed` MCP proxy bypass — ✅ PR 已就绪

分支：`pr/mcp-proxy-bypass-upstream`（基于 `upstream/main`，commit `1b00de58`）
- ✅ 剥离 happy-specific 路径引用（改为相对路径 `./utils/proxyBypass`）
- ✅ 补充 10 个单元测试（含 IPv6 `::1` 覆盖）
- ✅ `{ ...process.env }` 按需展开（仅在有 MCP servers 时）
- ✅ commit message 强调企业代理环境影响面
- ⏳ 待推送到 origin 并通过 `gh pr create` 提交

详细打磨方案见 `docs/plans/pr-mcp-proxy-bypass.md`

---

## 8. 风险矩阵

| 风险 | 概率 | 影响 | 缓解 | 状态 |
|------|------|------|------|------|
| daemon/run.ts cherry-pick 冲突 | 高 | 中 | 手动 patch 替代 cherry-pick | ✅ --kill-sessions 已手动解决 |
| auto-restore 部署不同步 | 中 | 低 | 部分部署无害，只是功能不生效 | ⏳ 待定 |
| controlServer 签名不兼容 | 中 | 高 | 确保 requestShutdown 签名改动与所有调用方同步 | ✅ 已同步 |
| bang 命令体系不一致 | 高 | 中 | 不合入重命名系列，保持 dev-main-v2 当前命名 | ⏳ 维持策略 |
| yarn.lock 冲突 | 确定 | 低 | 合入后 `yarn install` 重新生成 | ⏳ |

---

## 附录：pre-v3-clean 完整提交列表

> 共计 ~120+ 个提交，按时间正序排列。
> 详细列表请运行：`git log --oneline --reverse origin/compat/pre-v3-clean ^dev-main-v2`
