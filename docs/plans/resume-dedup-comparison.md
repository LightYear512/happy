# 远程会话恢复与认证体系分析

> 日期：2026-04-10
> 决策类型：两套远程恢复架构对比 + 认证依赖问题 + 改进方案评估

---

## 问题背景

用户在 App 中给一个已断开（CLI 进程退出）的会话发消息时，希望能自动恢复该会话，继续之前的 Claude 对话上下文。

两套方案解决同一个问题，但架构路径完全不同。

---

## 方案概览

### upstream（dev-main-v2 当前）：App 驱动 + 用户显式操作

```
用户在 App 中看到 session 已断开
        ↓
App: 显示 "Resume Session" 按钮 + 终端命令提示
  - useSessionQuickActions 检查前置条件（machine 在线、同机器、有 backendId）
  - 用户点击 Resume → RPC 调用 daemon 的 resumeSession
        ↓
Daemon: resumeSession(happySessionId)
  - resolveHappySession() 调 GET /v1/sessions API，用 agent.key 解密 metadata
  - buildResumeLaunch() 构建 `claude --resume <claudeSessionId>` 启动参数
  - spawnTrackedHappyProcess() 启动新 CLI 进程
        ↓
CLI: claude --resume <claudeSessionId>
  - Claude 恢复之前的对话上下文
```

### pre-v3-clean：Server 驱动 + 自动恢复

```
用户在 App 中给已关闭会话发消息
        ↓
Server: sessionUpdateHandler → tryRestoreSession()
  - 检测会话状态：inactive 或 zombie（lastActiveAt > 2min）
  - 校验 heartbeat cache（排除 DB 延迟假阳性）
  - 获取 restoring lock（30s TTL，防重复 spawn）
  - 通过 plainMachineId 路由到正确的 daemon（或 fallback 到任意在线 daemon）
  - 发射 'server-restore-session' socket 事件（明文，绕过 RPC 加密层）
        ↓
Daemon: 监听 'server-restore-session'
  - 读取 ~/.happy/restore/<sessionId>.json（会话持久化文件）
  - spawn CLI with --resume 恢复 Claude 上下文
  - summary 作为 title 保持会话名称连续性
        ↓
CLI: apiMachine.ts
  - 发送明文 claudeSessionId/summary/machineId 给 Server
  - Server 同步到 DB 供下次路由
```

---

## 维度一：效果

| 场景 | upstream（App 驱动） | pre-v3-clean（Server 驱动） |
|------|---------------------|---------------------------|
| 用户给断开会话发消息 | 消息存入 DB 但不会被处理，需用户手动点 Resume | **自动触发恢复**，消息被 CLI 拉取并处理 |
| 用户感知 | 看到断开提示 → 手动操作 → 等恢复 → 重发消息 | **无感知**，发消息即触发，恢复后 CLI 自动拉取未处理消息 |
| 恢复延迟 | 取决于用户操作速度 | ~3-5s（server 检测 + daemon spawn + CLI 启动） |
| 跨设备恢复 | ❌ 限制同机器（`resumeSessionSameMachineOnly`） | ✅ 通过 plainMachineId 路由到正确机器 |
| daemon 离线时 | 显示 "Machine offline" 提示 | 静默失败，lock 30s 后过期，用户可重试 |

**结论：pre-v3-clean 的用户体验显著优于 upstream——"发消息即恢复" vs "手动点按钮"。**

---

## 维度二：可用性

| 方面 | upstream | pre-v3-clean |
|------|----------|--------------|
| **触发方式** | 用户显式操作（点按钮/复制终端命令） | 自动（发消息即触发） |
| **前置条件检查** | App 端 7 项检查（machine 存在、backendId 存在、同机器、机器在线、支持 resume、不是新目录提示...） | Server 端 3 项检查（inactive/zombie、heartbeat、restoring lock） |
| **App UI** | Resume 按钮 + ResumeCommandHint + 复制终端命令 | 无额外 UI（透明恢复） |
| **数据依赖** | metadata 中的 claudeSessionId（需 agent.key 解密，通过 Server API 获取） | DB 中的 claudeSessionId + summary + plainMachineId（需 CLI 上报） |
| **多 flavor 支持** | ✅ Claude + Codex 双 flavor 分支 | ⚠️ 仅实现了 Claude flavor |
| **终端命令提示** | ✅ `getResumeCommandBlock` 生成可复制命令 | ❌ 无此功能（不需要，因为是自动恢复） |
| **zombie 检测** | ❌ 无——依赖 session 已被标记为 inactive | ✅ 有——server 检测 lastActiveAt > 2min 的活跃 session 为 zombie |

**结论：upstream 提供更多用户控制权和 fallback（终端命令），pre-v3-clean 提供更无感的体验但灵活性较低。**

---

## 维度三：稳定性

### upstream 的风险点

| 风险 | 说明 |
|------|------|
| 依赖 agent 凭据 | `resolveHappySession` 需要 `~/.happy/agent.key` 解密 Server API 返回的加密 metadata，agent.key 缺失或过期则无法恢复 |
| 同机器限制 | App 会检查 session 的 machine 和当前连接的 daemon 是否为同一台，跨机器无法恢复 |
| 无 zombie 检测 | 如果 CLI 崩溃未发 session-end，App 显示"在线"但实际无响应，需等心跳超时 |
| resume 失败无重试 | `resumeSession` 失败直接返回 error，无自动重试 |

### pre-v3-clean 的风险点

| 风险 | 说明 |
|------|------|
| DB 依赖 | claudeSessionId/summary/plainMachineId 需 CLI 主动上报到 DB，如果首次 session 上报失败则无法路由 |
| 明文传输 | 绕过 RPC 加密层直接用 socket 明文发送，安全性依赖 socket 本身的认证 |
| 单点 lock | restoring lock 是内存 Map，server 重启后丢失（但 30s TTL 使影响极小） |
| restore 文件持久化 | daemon 需为每个 session 写 `~/.happy/restore/<id>.json`，额外 I/O |
| 跨 server 实例 | 如果 server 水平扩展，内存 lock 无法共享（需改为 Redis） |

### 稳定性对比总结

| 维度 | upstream | pre-v3-clean |
|------|----------|--------------|
| 单机可靠性 | ✅ 高——本地文件 + 直接 RPC | ✅ 高——server 端检测 + daemon 端执行 |
| 分布式可靠性 | ⚠️ 同机器限制 | ✅ 通过 plainMachineId 路由 |
| 故障退化 | 用户可复制终端命令手动恢复 | 静默失败，30s 后可重试 |
| 数据完整性依赖 | 本地 session 文件 | DB 中 3 个额外字段 |

**结论：两套方案稳定性各有侧重。upstream 在单机场景更简单可靠，pre-v3-clean 在多机场景更强但引入了 server 端复杂性。**

---

## 维度四：实现路径

### 当前 dev-main-v2 已有的基础设施

| 组件 | 状态 | 说明 |
|------|------|------|
| `resumeSession()` in run.ts | ✅ 已实现 | daemon 端 resume 执行能力 |
| `resolveHappySession()` | ✅ 已实现 | 调 Server API + agent.key 解密 session metadata |
| `buildResumeLaunch()` | ✅ 已实现 | 构建 claude/codex --resume 启动参数 |
| `useSessionQuickActions` | ✅ 已实现 | App 端 resume 按钮逻辑 |
| Session control bar (Phase 5.7) | ✅ 已实现 | App 端 UI：fork/resume/stop 按钮 |
| RPC handler `resumeSession` | ✅ 已注册 | apiMachine.setRPCHandlers 中注册 |
| Server 端 restore API | ❌ 无 | sessionRoutes 中无 restore endpoint |
| DB claudeSessionId/summary 列 | ✅ 已有 | `8c0a3b63` 已添加到 Session 表 |
| DB plainMachineId 列 | ❌ 无 | 需额外 migration |
| tryRestoreSession server 逻辑 | ❌ 无 | sessionUpdateHandler 中无 restore 检测 |
| daemon restore 文件持久化 | ❌ 无 | daemon 不写 restore JSON |
| daemon 'server-restore-session' 监听 | ❌ 无 | daemon 不监听此事件 |

### 移植 pre-v3-clean 方案所需改动

| 步骤 | 涉及组件 | 工作量 | 风险 |
|------|---------|--------|------|
| 1. DB migration: 添加 plainMachineId | Prisma | 小 | ✅ nullable ADD COLUMN，安全 |
| 2. CLI 上报 plainMachineId | apiMachine.ts | 小 | 低 |
| 3. Server: tryRestoreSession | sessionUpdateHandler.ts | 中 | 中——需理解当前 handler 结构 |
| 4. Server: socket.ts 传 rpcListeners | socket.ts | 小 | 低 |
| 5. Daemon: restore 文件持久化 | run.ts | 中 | 低 |
| 6. Daemon: 监听 server-restore-session | run.ts | 小 | 低 |

总改动：~200-300 行，涉及 Server + Daemon + CLI + DB 四层，需协调部署。

### 保持 upstream 方案（零改动）

无需任何改动。当前 App 端 Resume 按钮已可用，用户可手动恢复。

---

## 维度五：互补性分析

**两套方案并非互斥，而是互补的：**

| 场景 | 最优方案 |
|------|---------|
| 正常断开，用户想恢复 | upstream（显式操作，用户有控制权） |
| CLI 崩溃/zombie，用户继续发消息 | pre-v3-clean（自动检测 + 恢复） |
| daemon 离线 | upstream（提供终端命令 fallback） |
| 跨机器恢复 | pre-v3-clean（plainMachineId 路由） |
| Codex session | upstream（已支持 codex flavor） |
| 多用户共享环境 | pre-v3-clean（server 端集中管理） |

**理想状态：两套方案共存——upstream 作为用户显式操作入口，pre-v3-clean 作为自动恢复兜底。**

---

## 决策建议

| 选项 | 说明 | 推荐 |
|------|------|------|
| A. 只用 upstream | 已有功能足够，手动 Resume 可用 | ⚠️ 可用但体验差——用户需手动操作 |
| B. 只移植 pre-v3-clean | 自动恢复体验好，但丢失终端命令 fallback | ⚠️ 不推荐——删除已有功能 |
| C. 两套共存（推荐） | upstream 做 UI/fallback，pre-v3-clean 做自动恢复 | ✅ **最优**——互补，无冲突 |
| D. 延后 pre-v3-clean | 先用 upstream，等需求明确再加自动恢复 | ✅ 可接受——当前 upstream 方案已可用 |

**推荐 C（两套共存），但 D 也合理——取决于"发消息自动恢复"的优先级。**

---

## 附录：upstream 方案的 happy-agent 认证依赖问题

### 问题描述

upstream 的 resume 流程依赖 happy-agent 的凭据（`~/.happy/agent.key`）才能解密历史 session 的 metadata。
原因是 CLI 的 `encryptionKey` 是会话级临时密钥，进程退出后消亡；而 agent.key 中的 account secret
可以派生 `contentKeyPair`，用于解密 server 端存储的 `dataEncryptionKey`，进而解密 metadata 拿到
`claudeSessionId` 等恢复所需信息。

这导致用户需要两次认证：`happy auth login`（CLI/machine 级）+ `happy-agent auth login`（account 级）。
两套认证使用不同的 server endpoint、不同的 DB 表、不同的 App deeplink，体验割裂。

### 改进方案评估

#### 方案 α：合并为一次扫码（Server 端同时返回两份凭据）

**思路：** 修改 `/v1/auth/request` 的 response，在一次扫码授权中同时返回 machine secret 和 account secret。

**可行性评估：**

| 维度 | 评估 |
|------|------|
| 技术可行性 | ⚠️ 中——不是简单加字段，两套认证用不同 DB 表（`terminalAuthRequest` vs `accountAuthRequest`）和不同 App deeplink（`happy://terminal?` vs `happy:///account?`） |
| 改动范围 | **大**——Server（新 endpoint 或合并逻辑 + DB 关联）+ App（新 deeplink scheme + 授权 UI 文案）+ CLI（解密后分别写两个文件） |
| 安全性 | ✅ 不降级——同一次人工授权 |
| 向后兼容 | ⚠️ 需三方协调——旧 CLI/旧 App/旧 Server 的组合需 fallback 路径 |

**边界场景：**

| 场景 | 处理 |
|------|------|
| 旧 CLI + 新 Server | 旧 CLI 不发 `requestAgentKey`，server 只返回 machine secret → 兼容 |
| 新 CLI + 旧 Server | server 不返回 agent secret → CLI 检测缺失，提示单独运行 agent auth → 退化 |
| 新 CLI + 旧 App | App 不认识合并 deeplink → 需 fallback 到两步流程 |
| Logout | `happy auth logout` 删除整个 `~/.happy/` 目录 → agent.key 连带删除 → re-login 必须同时恢复两份凭据 |
| Token 过期 | 两个 JWT 独立签发，一个过期另一个不受影响 → 可能出现部分失效 |

**结论：改动范围超预期，需 Server + App + CLI 三方协调发版，ROI 不高。❌ 不推荐。**

---

#### 方案 β：两次扫码但集成到 happy-cli 中（推荐）

**思路：** 把 `happy-agent auth login` 的逻辑（~80 行）搬进 `happy-cli`，在 CLI 认证完成后
紧接着提示用户进行第二次扫码。用户无需安装 happy-agent 包。

**架构：**

```
$ happy auth login

[第一步 — 已有流程]
Mobile Authentication
Scan this QR code with your Happy mobile app:
  [QR CODE 1 — machine auth, happy://terminal?<pubkey>]
  POST /v1/auth/request → 轮询 → 写 ~/.happy/credentials.json

✓ Authentication successful
✓ Machine registered: abc123

[第二步 — 新增流程，可选]
──────────────────────────────────
Session Resume Setup (optional)
──────────────────────────────────
Enable resuming closed sessions from the App?
This requires a second scan to authorize data access.

[Y/n]: Y

Scan this QR code with your Happy mobile app:
  [QR CODE 2 — account auth, happy:///account?<pubkey>]
  POST /v1/auth/account/request → 轮询 → 写 ~/.happy/agent.key

✓ Session resume enabled
```

**可行性评估：**

| 维度 | 评估 |
|------|------|
| 技术可行性 | ✅ 高——纯 CLI 端改动，Server/App 零改动 |
| 改动范围 | **小**——仅 `commands/auth.ts` 修改 + 新增 `commands/auth/agentAuth.ts`（~80 行从 happy-agent 移植） |
| 依赖 | ✅ 全部已有——`qrcode-terminal`、`axios`、`tweetnacl` 已是 happy-cli 依赖 |
| 安全性 | ✅ 不降级——与独立 happy-agent 完全等价 |
| 向后兼容 | ✅ agent auth 为可选步骤，不影响现有流程 |

**影响范围：**

| 组件 | 改动 | 工作量 |
|------|------|--------|
| `commands/auth.ts` handleAuthLogin | 修改：成功后检测 `agent.key`，缺失则提示 | 小 |
| `commands/auth.ts` handleAuthLogout | 修改：额外清理 `agent.key`（当前已删整个 `~/.happy/`，天然覆盖） | 无 |
| `commands/auth.ts` handleAuthStatus | 修改：显示 agent auth 状态 | 小 |
| 新增 `commands/auth/agentAuth.ts` | 从 happy-agent 移植 auth login（生成密钥对 → QR 码 → 轮询 → 写文件） | ~80 行 |
| 新增子命令 `happy auth agent` | 单独执行 agent auth（补扫码） | 小 |
| Server | 无改动 | — |
| App | 无改动 | — |
| happy-agent | 无改动 | — |
| package.json | 无改动（依赖已有） | — |
| apiMachine.ts | 无改动（`detectResumeSupport()` 热检测已有，发现 `agent.key` 自动注册 resume RPC） | — |

**边界场景全分析：**

| 场景 | 处理方式 | 问题？ |
|------|---------|--------|
| 首次 `happy auth login` | CLI auth → 提示 agent auth → 用户扫码 → 写 `agent.key` | ✅ 清晰 |
| 用户跳过 agent auth | resume 不可用，App 显示 "Needs Happy Agent" → 用户可随时 `happy auth agent` 补扫 | ✅ 退化路径清晰 |
| `happy auth logout` | 删整个 `~/.happy/` → `agent.key` 一同删除 → 下次 login 需重新两次扫码 | ✅ 一致 |
| `happy auth login --force` | 同 logout+login → agent.key 清除 → 流程中提示重新扫码 | ✅ 一致 |
| agent.key 过期/无效 | `resolveHappySession` 401 → 提示 `happy auth agent` | ✅ 明确 |
| agent.key 存在但 credentials.json 不存在 | daemon 无法启动，agent.key 残留无害 | ✅ 无害 |
| credentials.json 存在但 agent.key 不存在 | resume 不可用但其他功能正常 → `happy auth status` 提示 | ✅ 清晰 |
| 两份凭据绑定不同账户 | 用户分两次扫码可能用不同手机 → 需加 accountId 校验 | ⚠️ 需 ~10 行校验代码 |
| daemon 热检测 | apiMachine 每 60s heartbeat 调 `detectResumeSupport()` → 发现 `agent.key` 自动注册 resume RPC | ✅ 已有 |

**跨账户风险缓解：** agent auth 完成后，用 agent token 调 `GET /v1/sessions`（或轻量 endpoint），
对比返回的 accountId 与 CLI credentials 绑定的 accountId。不一致则警告用户重新扫码。

**新增子命令：**

```
happy auth agent          # 单独执行 agent auth（补扫码）
happy auth agent --status # 查看 agent auth 状态
happy auth agent --logout # 仅清除 agent.key
```

**结论：改动可控（~100 行），Server/App 零改动，向后兼容，体验从"装两个包各认证一次"提升为
"一个包内两步扫码"。✅ 推荐。**

---

### 两个改进方案对比

| 维度 | 方案 α（合并一次扫码） | 方案 β（CLI 内两次扫码） |
|------|----------------------|------------------------|
| 用户操作 | 1 次扫码 | 2 次扫码（第二次可选） |
| CLI 改动 | 中 | 小（~100 行） |
| Server 改动 | 大（新 endpoint + DB 关联） | **无** |
| App 改动 | 中（新 deeplink + 授权 UI） | **无** |
| 协调发版 | 三方同时 | 仅 CLI |
| 向后兼容 | ⚠️ 需 fallback | ✅ 天然兼容 |
| 安全性 | ✅ 不降级 | ✅ 不降级 |
| 跨账户风险 | ✅ 天然解决 | ⚠️ 需校验（~10 行） |
| 实施周期 | 长 | 短 |

**最终推荐：方案 β。** 以最小改动解决核心体验问题（无需安装 happy-agent），同时保持 Server/App 零改动的独立发版能力。

---

### 与 pre-v3-clean 明文上报方案的对比

无论选择方案 α 还是方案 β，都是在 upstream 的加密架构内优化认证体验。
而 pre-v3-clean 的明文上报方案从根本上绕过了认证问题——CLI 运行时主动上报
`claudeSessionId`/`summary`/`plainMachineId` 到 DB 明文字段，恢复时直接读取，无需解密。

| | upstream + 方案 β | pre-v3-clean 明文上报 |
|---|---|---|
| 额外认证操作 | 1 次扫码（可选） | 零 |
| 安全性 | 高（端到端加密） | 中（明文存 DB，内网可接受） |
| 改动范围 | CLI ~100 行 | Server + CLI + DB ~200-300 行 |
| 需协调部署 | 否（仅 CLI） | 是（Server + DB + CLI） |
| 功能完整性 | 完整（利用已有 resume 基础设施） | 需额外实现 server-restore-session 监听等 |

**两者可独立实施，也可共存——方案 β 优化认证体验，pre-v3-clean 提供自动恢复能力。**

---

## 附录 B：happy-agent 的定位与冲突风险

### happy-agent 的定位

happy-agent 是一个**远程控制面板**，定位类似 App 的 CLI 版本。README 明确：

> *Unlike `happy-cli` which both runs and controls agents, `happy-agent` only controls them.*

功能包括：`list`（列出 sessions）、`machines`（列出 machines）、`spawn`（远程 spawn）、
`resume`（远程 resume）、`create`（创建 session）、`send`（发消息）、`history`（查看历史）、
`status`（查看状态）、`stop`（停止 session）、`wait`（等待空闲）。

**所有功能都依赖 account secret（agent.key）**——因为所有数据（metadata、messages、agentState）
都是加密存储的，需要 account 级密钥解密。

App 端代码中有一条 TODO：
```
{/* TODO: migrate to `happy resume <happy-session-id>` once it works without happy-agent auth */}
```
说明 upstream 也认为当前依赖 happy-agent auth 不是理想状态。

### 方案 β 与 happy-agent 的冲突风险

| happy-agent 演进方向 | 冲突风险 | 说明 |
|---------------------|---------|------|
| auth 流程改变（如改用 OAuth） | 低 | CLI 移植的是 auth 调用逻辑，endpoint 不变则不受影响 |
| agent.key 格式变化 | 低 | `localHappyAgentAuth.ts` 读取 agent.key，格式变了两边都要改 |
| 新增功能（如 fork session） | 无 | CLI 只移植了 auth，其他功能各自独立 |
| happy-agent 被废弃或合入 CLI | 无 | 方案 β 正是朝这个方向走的第一步 |
| `deriveContentKeyPair` 算法变化 | 中 | CLI 的 `localHappyAgentAuth.ts` 和 happy-agent 的 `encryption.ts` 是手动复制的同一套逻辑，需同步修改 |
| `/v1/auth/account/request` endpoint 变化 | 中 | CLI 移植的 auth 逻辑直接调此 endpoint |

**重复代码警告：** `localHappyAgentAuth.ts` 中的 `deriveContentKeyPair`/`deriveKey` 与
`happy-agent/src/encryption.ts` 中的实现是手动复制的同一套逻辑。方案 β 再增加 auth 移植
会多一份重复。中期建议抽取为共享包（如 `@slopus/happy-auth`）。

### 方案 β 的扩展能力

一旦 CLI 通过方案 β 获得 agent.key，它就具备实现 happy-agent 所有功能的基础条件——
因为 happy-cli 已有完整的加密工具链（`encryption.ts`），只需新增 API 调用代码。

可以用 BangCommand 在 CLI 内重新实现 happy-agent 的能力：

| 功能 | BangCommand | 实现复杂度 |
|------|-------------|-----------|
| list sessions | `!sessions` | 低——移植 `listSessions` API 调用 |
| list machines | `!machines` | 低——移植 `listMachines` API 调用 |
| remote spawn | `!spawn <machine> <path>` | 中——需移植 RPC 调用 |
| remote resume | `!resume <session>` | 中——需移植 RPC 调用 |
| send message | `!send <session> <msg>` | 高——需移植 SessionClient |
| history | `!history <session>` | 低——API 调用 + 解密 |

这意味着方案 β 不仅解决 resume 认证问题，还为后续将 happy-agent 功能整合进 CLI 打开了通道。

---

## 附录 C：pre-v3-clean BangCommand 移植评估

### 现状对比

| | dev-main-v2 | pre-v3-clean |
|---|---|---|
| 已有命令 | `!auth` | `!auth`, `!auth-all`, `!login`, `!restart`, `!restart-all`, `!open`, `!session`, `!usage`, `!test`, `!help` |
| dispatcher | 简单（单命令注册） | 完整（desc/alias/sessionOnly/consoleOnly/hidden + `!help` 自动生成） |
| 基础设施 | 无 | `interactiveSession`（多轮交互路由）、`types.ts`（SEPARATOR/codeBlock 等） |

### 逐命令决策

#### `!auth` — CCS 账号切换 → ✅ 已有

dev-main-v2 已实现。pre-v3-clean 增加了 `!auth-all`（console 模式切换全部会话）和
shared context group 感知，但这些依赖 console session 概念，dev-main-v2 无此概念，暂不需要。

#### `!login` — 远程登录 Claude 账户 → ❌ 延后

~300 行，spawn `claude` 进程用 node-pty，监听 PTY 输出检测 OAuth URL/成功/失败，
通过 `interactiveSession` 路由用户输入。依赖链深（PTY + interactiveSession + console 模式 +
errorFormatter），主要在 macOS 验证。当前 dev-main-v2 无 console session，延后。

#### `!restart` / `!restart-all` — 重启会话 → ✅ 移植

实现简单（~50 行），核心只是返回 `{ action: 'restart-session' }`，由 launcher 处理实际重启。
实用性高——App 用户可重启卡住的会话。`!restart-all` 依赖 console session，暂不移植。

#### `!open` — 打开/恢复历史会话 → 🔄 基于方案 β 重新设计

pre-v3-clean 实现：扫描本地 `~/.claude/projects/` 文件 → 找到匹配 session → 调
`spawnDaemonSession` 恢复。局限：只能看本机 session，依赖 Claude 内部文件结构。

**方案 β 带来的更优路径：** 读 agent.key → GET /v1/sessions → 解密 metadata → 展示列表 →
用户选择 → RPC `resume-happy-session`。覆盖远程 + 本地，不依赖本地文件结构。

#### `!session` — 查看会话信息 → 🔄 合并到 `!open`

pre-v3-clean 实现：~200 行，扫描 `~/.claude/projects/` 目录结构，解析 JSONL。
同样受限于本地文件。建议与 `!open` 合并为统一的 session 管理命令 `!sessions`。

#### `!usage` — 查看 API 用量 → ⚠️ 延后

~250 行，读取 Claude OAuth token → 调 Anthropic API 查用量。依赖 `readOAuthToken()`
和 macOS Keychain 读取（`security` 命令），Windows 环境不完整。
dev-main-v2 也缺少 `usageCommand.ts` 和 `errorFormatter.ts`。延后。

#### `!test` — 视觉测试 → ❌ 不移植

开发调试工具，hidden from help，仅开发时使用。

#### `!help` — 帮助 → ✅ 随 dispatcher 增强

pre-v3-clean 的 dispatcher 有 `desc` 字段，`!help` 从命令注册表动态生成。
增强 dispatcher 时自然获得。

#### `interactiveSession` — 交互式会话系统 → ❌ 延后

仅被 `!login` 使用。`!login` 不移植则此系统不需要。

### 决策总结

| 命令 | 决策 | 优先级 | 与方案 β 关系 |
|------|------|--------|-------------|
| `!auth` | ✅ 已有 | — | 无关 |
| `!auth-all` | ❌ 延后 | — | 无关 |
| `!login` | ❌ 延后 | — | 无关 |
| `!restart` | ✅ **移植** | P1（立即） | 无关 |
| `!restart-all` | ❌ 延后 | — | 无关 |
| `!open` + `!session` | 🔄 **重新设计为 `!sessions` + `!resume`** | P2（方案 β 后） | **核心受益者** |
| `!usage` | ⚠️ 延后 | P3 | 无关 |
| `!test` | ❌ 不移植 | — | 无关 |
| `!help` | ✅ 随 dispatcher 增强 | P1 | 无关 |
| `interactiveSession` | ❌ 延后 | — | 无关 |

### 方案 β 后的 BangCommand 新设计

pre-v3-clean 的 `!open` 和 `!session` 基于本地文件扫描，有明显局限（只看本机、依赖
Claude 内部文件结构）。方案 β 就位后，可基于 Server API 实现更强大的替代：

```
!sessions              → GET /v1/sessions（agent.key 解密）→ 列出所有 session
!sessions --active     → 只显示活跃 session
!resume <id>           → 解密 metadata → RPC resume-happy-session
!machines              → GET /v1/machines → 列出所有 machine
```

优势：跨机器可见、不依赖本地文件结构、走加密通道。

### 实施路线

1. **立即可做（P1）：** `!restart` 移植 + dispatcher 增强（desc/alias/`!help`）
2. **方案 β 完成后（P2）：** `!sessions` + `!resume` + `!machines`（基于 agent.key）
3. **后续（P3）：** `!usage`（等跨平台支持）、`!login`（等 console session 体系）

---

## 附录 D：pre-v3-clean 更新同步（截至 2026-04-14）

### 最新提交范围

`aacfe9f2..a9004b7e`，新增约 30 个提交，主要变化：

### 1. BangCommand 演进

| 变化 | 提交 | 影响 |
|------|------|------|
| `!title` 命令**已删除** | `6ac95fbb refactor(bang): drop !title command and flavor-scoped welcome` | 无需移植 |
| `!session` / `!open` **被暂停** | 注释标记"待 multi-backend 会话浏览重构后恢复" | 印证方案 β 方向 |
| 新增 `relativeTime.ts` 工具 | 从 `sessionCommand` 拆出 | 小工具，可按需移植 |
| `loginCommand.ts` **大幅增强**（+787 行） | `3f443c3c`, `8ead4f58`, `097016de` 等 | Codex OAuth + lock-first + 两阶段恢复，18 个新测试。实现更复杂，延后依然合理 |
| `usageCommand.ts` 重构 | `14e7c6ef`, `90bba36f` | 移除 `contextMode` 限制 |
| `authCommand.ts` 重构 | `3bd6fd93`, `90bba36f` | Console 分支独立处理，移除 `isSharedContext` |

### 2. `!session` / `!open` 暂停的关键证据

pre-v3-clean 最新 `dispatcher.ts` 明确注释：

```ts
// TODO: !session / !open 暂停使用，待 multi-backend 会话浏览重构后恢复。
// 实现保留在 sessionCommand.ts / openCommand.ts。
// 'session': { handler: handleSessionsBangCommand, ... },
// 'open':    { handler: handleOpenBangCommand, ... },
```

**这印证了附录 C 的判断：** 本地文件扫描方案存在根本局限，上游也在等 multi-backend 重构。
我们基于方案 β 的 `!sessions` + `!resume` 新设计反而可能**先于 pre-v3-clean 完成**。

### 3. Server 端 `tryRestoreSession` 稳定性修复

| 提交 | 修复内容 |
|------|---------|
| `d99ec436 fix(socket): tryRestoreSession explicitly revives session (DB + cache + ephemeral)` | 修复 zombie session 复活——需显式更新 DB + cache + ephemeral 三处状态 |
| `90633a1e fix(presence): gate heartbeat flush by dead flag to stop session resurrection` | 防止心跳回写让已标记为 dead 的 session 复活 |

**对明文上报方案的影响：** 如果后续选择合并 pre-v3-clean 的明文上报方案，
必须同步这两个修复，否则会遇到同样的生产 bug。

### 4. Codex 一等支持

pre-v3-clean 对 Codex 的支持大幅提升：

| 提交 | 说明 |
|------|------|
| `7e921e33 feat(codex): add app-server backend, MCP reconnect, and live profile switching` | Codex 后端重大升级 |
| `845e48d7 feat(codex): support session restore by ID and auto-approve MCP tool calls` | Codex session restore by ID |
| `af16b71c feat(codex): add Codex bang command support` | BangCommand 支持 Codex flavor |
| `fb260c7a refactor(bang): simplify Codex auth, extract relativeTime, rename codex-shared dir` | Codex auth 简化 |

**影响：** dev-main-v2 后续若跟进 Codex 支持，需关注这些提交。当前评估范围暂不覆盖。

### 5. Daemon 稳定性

| 提交 | 说明 |
|------|------|
| `384109ce fix(daemon): use killProcessTree for reliable cross-platform process cleanup` | 跨平台进程清理 |
| `db6ad522 fix(daemon): parallelize stopSession and clear watchdog on graceful shutdown` | 优雅关闭优化 |
| `4fe518bd refactor(utils): make killProcessTree async to unblock event loop` | 异步化避免阻塞 |
| `ebc26d10 refactor(doctor): reuse shared killProcessTree` | 共用工具 |
| `7cf962a2 feat(utils): add processKill and shutdownHandlers utilities` | 新增工具 |

**对 dev-main-v2 的价值：** `killProcessTree` 跨平台修复对 Windows 环境特别有价值，值得后续独立评估移植。

### 6. 对既有决策的影响

| 原决策 | 是否仍有效 | 更新理由 |
|--------|----------|---------|
| `!restart` 移植（P1） | ✅ 仍有效 | 无变化 |
| `!open` / `!session` 重新设计 | ✅ **更有信心** | 上游也判定旧实现有问题并暂停 |
| `!login` 延后 | ✅ 仍有效 | 上游重构后实现更复杂（+787 行），延后依然合理 |
| `!usage` 延后 | ✅ 仍有效 | 依赖未变 |
| `!title` 移植 | ❌ 失效 | 上游已删除 |
| 明文上报方案 | ⚠️ 需同步修复 | 若选择此方案必须带上 `d99ec436` + `90633a1e` |
| 方案 β（CLI 内 agent auth） | ✅ **更有信心** | 上游的 multi-backend 重构方向和方案 β 对齐 |

### 7. 新增优先级

| 项 | 优先级 | 说明 |
|------|-------|------|
| `killProcessTree` 跨平台修复 | P2 | Windows 稳定性价值高，独立可移植 |
| Server 端 `tryRestoreSession` 两个 bug 修复 | 绑定明文上报方案 | 若不选择明文上报则无需 |
| Codex 一等支持 | P4（独立评估） | 不在当前评估范围内 |
