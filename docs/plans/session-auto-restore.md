# 已关闭会话自动恢复

> **历史方案，已被取代**：本文描述“创建新 Happy session”的旧设计，与当前精确复用原
> Happy session 的实现不一致，不得作为实现依据。当前根因分析、状态权威、最小生产方案和
> 验收标准见 [`../analysis/happy-remote-baseline-stabilization.md`](../analysis/happy-remote-baseline-stabilization.md)。

## 目标

用户在 App 端已关闭的会话中发送任意消息，系统自动恢复 Claude 上下文，创建新的 happy session 继续对话。

## 核心设计决策

1. **任意消息触发** — 用户发送的第一条消息作为唤醒信号，session 恢复后在新窗口继续对话
2. **创建新 happy session** — 不复用旧 session（避免加密 key 冲突），Claude 上下文通过 `--resume` 恢复
3. **Server 不读消息内容** — 只检查 `session.active` + `lastActiveAt`，不破坏 E2E 加密
4. **Server → Daemon 直连事件** — 使用独立的 `server-restore-session` socket 事件，绕过 RPC 加密层
5. **resume 失败不降级** — 直接报错，避免上下文不一致
6. **触发消息不送达 Claude** — 旧 session 的消息留在旧 session 中，新 session 从空消息开始
7. **修改边界** — DB + Server + Daemon + CLI，不改 App

## 架构

```
App (用户在已关闭会话中发消息)
  │
  ▼
Server (存 DB → 检测 active 状态 → 从 rpcListeners 找 daemon socket)
  │         (查 Session.claudeSessionId 明文字段)
  │
  ▼
Server → socket.emit('server-restore-session', { sessionId, claudeSessionId })
  │       (直连事件，不走加密 RPC 通道)
  │
  ▼
Daemon (从磁盘读 directory/agent → 继承 process.env → spawn CLI)
  │
  ▼
CLI (--resume <claudeSessionId>)
  │  (创建新 happy session → 新 tag → 新 encryptionKey)
  │
  ▼
App 收到 new-session 事件 → 正常初始化新 key → 新会话窗口
  │
  ▼
用户在新窗口发消息 → Claude 有完整上下文（通过 --resume）
```

## 为什么创建新 session 而非复用旧 session

每个 happy session 有独立的 `encryptionKey`（随机生成）。旧 key 锁在 `dataEncryptionKey`
中（用 publicKey 非对称加密），本地无 private key 解密。

如果复用旧 session（相同 tag），会产生以下无法解决的问题链：
1. 新 CLI 生成新 encryptionKey → Server 的 `POST /v1/sessions` 需要 upsert 覆盖旧 metadata
2. App 缓存了旧 encryptionKey → 需要 App 刷新 key
3. App 的 `initializeSessions()` 跳过已初始化的 session → 不会更新 key
4. 尝试 `delete-session` + `new-session` 广播 → session 从 UI 消失再出现，体验差

创建新 session 彻底绕开所有加密问题：新 session = 新 key = App 正常初始化。

## DB 变更

```prisma
model Session {
  ...
  claudeSessionId  String?   // 明文，仅 UUID，不敏感
  summary          String?   // 明文，用户自定义标题
  plainMachineId   String?   // 明文，用于 restore 时路由到正确 daemon
}
```

CLI 更新 metadata 时同步写入这三个明文字段。`/clear`、`/compact` 等操作改变
`claudeSessionId` 后，明文字段自动跟随更新。

## 完整流程

### 1. 正常运行时：CLI 同步明文字段

CLI 更新 metadata 时（含 /clear、/compact 后）：
- 发送 `update-metadata` 事件
- payload: `{ metadata: encryptedBlob, claudeSessionId?, summary?, machineId? }`
- Server 存加密 metadata 到 `session.metadata`
- Server 存明文字段到对应列

### 2. 首次 spawn 或 session webhook：Daemon 持久化 restore 文件

任何 session（daemon-spawned 或 terminal-started）注册到 daemon 时，写入磁盘：

```json
// ~/.happy/restore/<happySessionId>.json
{
  "directory": "/path/to/project",
  "agent": "claude"
}
```

仅 2 个字段，全部不敏感，不会过期。不存储 auth token — restore 时从
daemon 的 `process.env` 实时继承（OAuth/CCS 管理的凭据始终有效）。

### 3. 会话关闭后：用户发消息触发 restore

#### Step 1 — Server message handler

```
a. 存入 DB，分配 seq（已有逻辑，不改）
b. 广播给 session-scoped 连接（已有逻辑，不改，无人接收）
c.【新增】判断是否需要 restore:
   - active=false → 需要
   - active=true && lastActiveAt < now - ZOMBIE_THRESHOLD(2min) → 假死，需要
   - 否则 → 正常，不处理
d.【新增】检查 restoring 锁（内存 Map，带 30 秒 TTL）:
   - restoring=true 且未超时 → 跳过（消息已存 DB）
   - 否则 → 设置 restoring=true，继续
e.【新增】查 Session → claudeSessionId（明文字段）
f.【新增】从 rpcListeners 找到 daemon socket（用 plainMachineId 精确匹配，降级为任意 daemon）
g.【新增】直接 emit 'server-restore-session' 事件（不走加密 RPC）
   参数: { sessionId, claudeSessionId }
```

`ZOMBIE_THRESHOLD = 2min`，定义为命名常量，注释说明
`> CACHE_WRITE_INTERVAL(30s) + BATCH_INTERVAL(5s)`。

#### Step 2 — Daemon

```
a. 收到 server-restore-session 事件（独立 socket 事件，非加密 RPC）
b. 读 ~/.happy/restore/<sessionId>.json → directory, agent
c. spawn CLI:
   env: process.env (daemon 自身环境，含 OAuth/CCS token)
   args: [agent, --happy-starting-mode remote, --started-by daemon,
          --resume <claudeSessionId>]
   cwd: directory
d. 等待 session webhook（15 秒超时）
```

#### Step 3 — CLI

```
a. 创建新 happy session（新 tag → 新 encryptionKey → 全新 session）
b. --resume <claudeSessionId> → Claude 恢复对话上下文
c. 进入 remote mode，等待新消息
```

App 收到 `new-session` 事件 → 正常初始化新 encryption key → 显示新会话。
用户在新会话窗口发消息 → 正常加解密 → Claude 有完整对话上下文。

#### Step 4 — Server 后续

```
a. 收到 keepAlive → 清除 restoring 锁
b. spawn 失败/超时/TTL 到期 → 清除 restoring 锁
```

## 假死处理

```
CLI 崩溃（未发 session-end）→ active=true, lastActiveAt 停滞
  → 用户发消息
  → Server: active=true 但 lastActiveAt < now - 2min → 判定假死
  → 设 active=false → 触发 restore
  → 如果老 CLI "复活"发 keepAlive → 优先新 CLI，daemon stop 老进程
```

## 错误处理

| 场景 | 行为 |
|------|------|
| Daemon 离线 | 找不到 daemon socket，消息已存 DB，用户启动 daemon 后再发消息重试 |
| Spawn 超时 | 清除 restoring 锁，消息保留，用户重试 |
| Resume 失败 | 报错不降级，告知用户 Claude 会话文件不存在 |
| 连发消息 | restoring 锁（30s TTL）防重复 spawn，消息存 DB |
| 假死 session | lastActiveAt 超时判定 + 优先新 CLI |
| Daemon 重启后 restore | 磁盘持久化文件仍在，claudeSessionId 从 Server 明文字段获取 |
| 持久化文件缺失 | 返回错误，用户需通过 "+" 新建会话 |
| restoring 锁泄漏 | 30s TTL 自动清除，下条消息重新触发 |
| 目录已删除 | daemon 目录校验失败，返回错误 |

## 改动清单

| 层 | 文件 | 改动 |
|---|---|---|
| **DB** | `schema.prisma` | Session 新增 `claudeSessionId String?` + `summary String?` + `plainMachineId String?` |
| **Server** | `sessionUpdateHandler.ts` | update-metadata 时同步写 claudeSessionId + summary + plainMachineId |
| **Server** | `sessionUpdateHandler.ts` | message handler 新增 restore 检测 + restoring 锁 + 直连事件 |
| **Server** | `socket.ts` | 传递 rpcListeners 给 sessionUpdateHandler |
| **Daemon** | `run.ts` | restore 文件持久化（session webhook 时写入）+ restoreSession 函数 |
| **CLI** | `apiMachine.ts` | `server-restore-session` 直连事件 handler |
| **CLI** | `apiSession.ts` | updateMetadata 附带明文 claudeSessionId + summary + machineId |

## 不做的事

- 不改 App — 新 session 通过标准 new-session 事件通知
- 不复用旧 happy session — 避免加密 key 冲突
- resume 失败不降级 — 避免上下文不一致
- 不做离线排队 — daemon 不在线时消息存 DB，用户重试
- 不做跨机器恢复 — MVP 限定原机器
- 不持久化 auth token — 从 daemon process.env 实时继承
- 不拉取旧 session 的消息 — 加密 key 不兼容，旧消息留在旧 session 中
