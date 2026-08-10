# Happy 输入、停止与恢复可靠性：历史方案

> **状态**：已由 `docs/analysis/happy-remote-baseline-stabilization.md` 取代；仅供历史对照，禁止实施
> **证据截止**：2026-08-10 10:31 CST
> **比较基线**：`HEAD=origin/compat/pre-v3-clean=adc3a68a97a8`；因此本文所述新增行为全部来自未提交工作树，基线缺陷会单独标明。
> **适用范围**：Happy App、Happy Server、Happy CLI、Daemon，以及它们之间的输入、停止、精确恢复和运行时切换链路。
> **不适用范围**：Codex、Claude、Gemini 等上游模型客户端内部实现；XC 调度语义；无关的文件搜索、补全、翻译和 UI 改版。

## 1. 结论

当前问题不是一个单点 bug，而是五个边界同时失去了一致语义：

1. App 把 Socket.IO `emit` 当成“已提交”，实际没有服务端持久化确认。
2. CLI 在“持久消息恢复完成、输入消费者注册完成”之前就发布 `connected`，Daemon 又把它当成可输入。
3. 精确恢复查询失败后，当前实现为保证实时输入可用会直接放弃离线窗口；恰好用于唤醒会话的首条持久消息可能永远不再广播，仍存在丢失风险。
4. 本地改动删除了 10 秒心跳和 30 秒新鲜度判断，却没有以低成本活性协议替代；Daemon 只能在“永久相信旧记录”和“每次用 `SIGCONT` 探测”之间摇摆。
5. hard kill 把会话写成 `archived`，Codex 精确恢复路径未在真正 input-ready 后清除归档字段；后端进程已运行而 UI 仍显示停止。

此外，同一台机器上长期运行的会话不会热加载新 `dist`，在原目录反复构建会造成多个运行时版本并存。它不是上述语义错误的第一根因，却会让不同会话表现不一致，显著放大排障难度。

本轮反向自审还发现：直接按上一版方案把首连保持为 `reconciling` 会与当前
`fetchAndInjectPendingMessages() → waitForConnect()` 形成自锁；Server 的 20 秒 restore RPC
又短于 Daemon 最坏 15 秒 identity + 35 秒 provider 两阶段门禁，30 秒 restoring TTL 和候选进程
每 2 秒发出的 `session-alive` 还可能提前释放互斥与发布 active。故恢复必须被设计成一个有界、
可补偿、两阶段注册的单次事务，而不是只修改一个 `connected` 枚举值。

**当前产品/产物判定：FAILING。** 当前代码仍不满足本文承诺；本文通过只表示设计闭环，
不表示实现或发布已经完成。

最小完整方案不是增加第二套调度器、消息数据库或无限重试，而是建立四个明确承诺：

- App 只在服务端数据库提交后显示“已发送”，以现有 `localId` 唯一约束实现幂等。
- `connected` 只表示端到端 input-ready，不再表示“Socket 已连上”。
- `running` 只在同一时刻的 input-ready 提交成功后发布，归档字段与运行字段互斥。
- Daemon 使用独立、轻量、有 TTL 的健康证明；完整元数据只在状态变化时上报。

## 2. 用户需求与验收承诺

| ID | 需求 | 设计处置 | 可执行验收 | 失败表现 |
|---|---|---|---|---|
| R1 | 用户第一次输入不能无响应，重输一次才生效 | 服务端持久化 ACK；恢复窗口完成前不发布 input-ready | 关闭会话后只发送一次，恢复后模型只收到一次 | App 提前清稿、首条消息未入模型或重复入模 |
| R2 | “已发送/正在处理”必须反映真实阶段 | UI 区分本地待确认、服务端已持久化、CLI 已接纳、模型处理中 | 断网、ACK 丢失、恢复慢时状态可区分 | 本地 `emit` 后直接显示已提交 |
| R3 | 停止和重启后 UI、Daemon、进程状态一致 | 归档与运行字段互斥；input-ready 后原子恢复运行态 | 同一 Happy ID 和 provider ID 恢复，UI 只在就绪后转运行 | 进程活着但 UI 仍 archived，或 UI running 但不可输入 |
| R4 | 活进程卡死时可识别，正常会话不能被频繁误唤醒 | 10 秒轻量健康证明、30 秒 TTL、过期后一次有界探测 | fresh 会话无 `SIGCONT`；冻结事件循环后 30 秒内变 stale | 永久相信旧健康文件或每次打开都探测 |
| R5 | 停止来源可追踪且不误杀 | abort、safe stop、hard kill 三条语义分离；结构化来源日志 | 每次 hard kill 都能关联 requestId、来源、会话和服务端调用方 | 只能看到 `killSession`，无法确认谁发起 |
| R6 | 新代码上线后所有会话行为一致 | 不可变 release 目录 + 受控 drain/restart | 活跃进程的 releaseId 全部一致 | 同机旧子进程继续跑旧协议 |
| R7 | 修复最简、可回滚、不修改模型客户端 | 只改 Happy 四层；复用现有 DB 唯一约束、状态枚举和 Daemon 控制面 | 不依赖 Codex 变更；上一 release 可恢复 | 新建第二消息权威、全局 scheduler 或源码 reset |
| R8 | 同一 session 恢复不能重入、超时后不能留下幽灵 child | 单 session in-flight 合并、两阶段 candidate/ready、统一 deadline、失败补偿 | 并发触发只 spawn 一次；超时必终止候选；late ack 不激活 DB | TTL 到期后重复 spawn、Server 超时而 child 后续变 ready |

## 3. 证据分级与边界

### 3.1 已证事实（Fact）

- 证据快照时 `HEAD` 与远端基线相同，工作树有 59 个 tracked 变更和 11 个 untracked 项；相关热文件 scoped diff 指纹为 `8e00e3a9440143978b03e1e3545f322cc623fefb5ea993ee756cdd853771e6d0`。工作树在并发开发，数字只描述上述时间点。
- `packages/happy-app/sources/sync/sync.ts::sendMessage` 先插入本地乐观消息，再调用 `apiSocket.send('message', ...)`，随后立即返回 `{ submitted: true }`。
- `packages/happy-app/sources/sync/apiSocket.ts::send` 只调用 `socket.emit`，没有 ACK；`SessionView` 随即清空输入与持久草稿。
- `packages/happy-server/sources/app/api/socket/sessionUpdateHandler.ts` 已有 `(sessionId, localId)` 唯一持久化语义，但 `message` handler 不接收 ACK callback，且广播明确跳过发送连接。
- `ApiSessionClient` 在 exact restore 构造时设置 `initialRestorePending/reconciling`，但首次 Socket 连接仍立即发布 `connected`。
- 当前 `fetchAndInjectPendingMessages()` 先调用 `session.waitForConnect()`；该方法要求 transport state 已是 `connected`。因此若只禁止首连发布 connected，恢复查询将无法启动。
- 当前恢复查询单次超时为 3 秒；查询失败会调用 `continueAfterRecoveryLookupFailure()`，只合并连接后缓存的实时消息，不可能重新获得连接前已持久化但未广播的唤醒消息。
- Codex handler 在输入消费者注册后并行启动持久消息恢复，又在 provider thread 恢复后立即调用 `notifyDaemonSessionStarted()`；该通知不等待持久窗口完成。
- 本地 diff 删除了 10 秒健康心跳和 30 秒 freshness 常量；Daemon 的 `classifyTrackedInputState()` 对 `connected` 记录不再检查年龄。
- Daemon 对部分已经分类为 online 的当前子进程仍发送 `SIGCONT` 并等待 proof generation 前进，最长等待 15 秒。
- Codex hard kill 路径写入 `lifecycleState='archived'`、`archivedBy='cli'`、`archiveReason='User terminated'`；Codex 精确恢复路径没有与 input-ready 绑定的 `running` 提交。
- 当前 `ApiSessionClient.updateMetadata()` 使用无限 `backoff`，`emitWithAck` 没有 deadline；Server 的 session-not-found 分支又可能不调用 callback，不适合作为恢复事务的有界 lifecycle commit。
- Server `tryRestoreSession()` 的 RPC deadline 是 20 秒、restoring lock TTL 是 30 秒；Daemon startup deadline 最坏为 15 秒 identity 后再等 35 秒 provider。
- Codex App Server 在 provider/input recovery 就绪前即启动 2 秒一次的 `session-alive`；Server 收到它会发布 active presence 并删除 restoring lock。
- 2026-08-10 的 x125 日志显示：旧 PID 19031 收到显式 `killSession` RPC 后以 exit code 0 退出，不是崩溃；新 PID 21863 随后恢复 provider，但仍上报旧的 archived 元数据。
- 旧文档 `docs/plans/session-auto-restore.md` 要求创建新 Happy session；当前实现复用原 Happy session。该文档不再是当前权威。

### 3.2 基于事实的推断（Inference）

- “第一次没反应、第二次才好”最直接的链路是：第一次消息已写服务端但恢复窗口查询失败或 input-ready 被提前宣告，消息未进入模型消费者；第二次发生在新 CLI Socket 已连接后，可由实时广播送达。
- x125 “停止后又活着但 UI 仍停止”由归档元数据未在恢复完成后清除解释，与观察到的日志时间线一致。
- 某些会话显著慢于其他会话，除网络和模型延迟外，还受 stale 健康记录触发的 15 秒探测与混合运行时影响。
- 原先每 10 秒把完整 session webhook 当健康心跳会产生高 CPU、磁盘和日志成本；删除它降低资源消耗，但同时删除 freshness 使正确性退化。
- 20 秒 Server timeout 早于 Daemon 合法完成上限，可能出现 Server 已报失败而 daemon handler 仍继续、候选 child 后续变 ready 的 late-success/幽灵进程窗口。
- 恢复中的 `session-alive` 会让 UI/Server presence 早于 input-ready，并可能使同 session 的后续触发跳过必要恢复。

### 3.3 当前未知（Unknown）

- x125 的 `killSession` RPC 日志没有调用方身份，无法从现有证据断言是用户、App、服务器恢复逻辑还是其他客户端发起。
- 当前手机端安装包是否包含本工作树的 App 改动尚未由 release/build 标识证明；因此不能把所有现场现象都归因于本地 App diff。
- x28 每一次无响应是否都经过同一失败链路，需要为一次复现采集 message localId、restore requestId 和 health generation 才能精确确认。
- 服务端和移动端部署版本未纳入本次本地证据快照。

### 3.4 设计假设（Assumption）

- Server、App、CLI 和 Daemon 都属于允许修改的 Happy 范围，上游 Codex 不改。
- 服务端现有 `(sessionId, localId)` 唯一索引继续作为消息持久化幂等权威。
- 10 秒健康间隔、30 秒 freshness 是默认值；实现时可配置，但协议测试使用确定值。

## 4. 远端差异归因

### 4.1 直接引入或暴露问题的改动

| 改动 | 正向意图 | 当前缺口 | 归因 |
|---|---|---|---|
| App 删除 `waitForAgentReady()`，直接持久化消息 | 不让输入被不可靠的 `agentStateVersion` 阻塞 | `emit` 被误当成 DB commit；没有 ACK/歧义恢复 | 新工作树直接问题 |
| CLI 引入持久化恢复与有序队列 | 精确恢复离线输入，避免 socket race | 首连先发布 connected；3 秒查询失败后放弃离线窗口 | 新工作树直接问题 |
| Daemon 删除高频完整 webhook 心跳 | 降低 CPU、日志和网络开销 | freshness 一并删除；online 变成永久标签或依赖主动探测 | 新工作树直接问题 |
| Daemon 强化 exact provider proof | 防止恢复到错误线程 | proof 与端到端输入就绪仍是两个概念 | 新工作树边界未闭合 |

### 4.2 基线已有、被新恢复链路放大的缺陷

| 缺陷 | 基线状态 | 为什么现在更明显 |
|---|---|---|
| hard kill 后 archived 字段不会在 Codex 恢复完成时清除 | 远端基线已有 | 现在强调复用同一 Happy session，旧元数据随会话一起复用 |
| kill RPC 缺少发起者证据 | 远端基线已有 | 自动恢复、App 和多会话并存后，仅凭目标会话日志无法还原来源 |
| 长进程不会热加载新构建 | Node 运行时固有 | 当前工作树频繁原地构建，导致同机协议混用 |

### 4.3 与问题无关或主要是修复的改动

- 单个 `@` 作为普通输入、仅 `@@` 打开命令菜单，是输入路由修复，不是首条输入丢失根因。
- 文件搜索、autocomplete、RPC 容量边界、yolo、翻译等改动与本链路无直接因果关系。
- daemon child 避免重复 machine registration 是所有权收敛，不是停止/恢复异常根因。
- App-server stream bridge 的状态透传本身不是问题，错误在 ready/connected 的定义过宽。

## 5. 当前链路与第一分歧点

### 5.1 当前输入路径

```text
SessionView
  ├─ 清空输入与草稿
  └─ Sync.sendMessage
       ├─ 本地插入 optimistic message
       └─ Socket.IO emit ────────┐
                                 ▼
Server message handler ── DB SessionMessage(localId unique)
       ├─ 广播给其他 interested connections
       └─ inactive/zombie 时触发 restore
                                 │
                                 ▼
Daemon spawn/open ── provider ready webhook ── 返回“成功”
                                 │
                                 ▼
CLI socket + pending-message GET + onUserMessage + model queue
```

这里有三个不同的“成功”，当前被混为一个：

1. App Socket 已发射；
2. Server 消息已提交数据库；
3. CLI 已完成恢复并把消息交给模型入口。

### 5.2 第一分歧点

最早可修复的分歧是 App 把无 ACK 的 `emit` 解释为 `submitted`。即使后端恢复完全正确，断连或 server handler 失败也会造成 UI 假成功。

针对“会话恢复后首条输入”的后端第一分歧是 `ApiSessionClient.handleSocketConnect()`：`initialRestorePending=true` 时仍发布 `connected`。从这里开始，Daemon/UI 看到的 ready 不再等价于“离线消息窗口已合并且消费者可接纳”。

## 6. 目标语义与唯一权威

### 6.1 权威划分

| 状态/事实 | 唯一权威 | 非权威缓存或投影 |
|---|---|---|
| 用户消息是否已接收 | Server `SessionMessage` 行，键 `(sessionId, localId)` | App optimistic message、Socket emit 状态 |
| provider 身份 | 已成功 resume/start 的 provider thread ID | restore 请求参数、旧 metadata |
| 端到端输入就绪 | CLI transport health 的 `connected` 提交 | Socket connected、provider ready 单项 |
| 会话是否运行 | Server metadata lifecycle；只能由 input-ready 提交驱动 | UI 图标、Daemon pid 表 |
| 进程是否活跃 | 新鲜 health generation + PID/processStartedAt | 旧 health 文件、仅 `kill(pid, 0)` |
| hard kill 来源 | Server/入口结构化请求日志 | 目标 CLI 的“收到 killSession”日志 |

### 6.2 必守不变量

1. `submitted=true` ⇒ Server 已提交可按 `localId` 查询的消息行。
2. `transportState=connected` ⇒ Socket 已连、精确 provider 已恢复、`onUserMessage` 已注册、初始持久窗口已完整解析并合并。
3. `lifecycleState=running` ⇒ 当前唯一 owner 已提交 input-ready，且 `archivedBy/archiveReason` 不存在。
4. `lifecycleState=archived` ⇒ 不存在已被接受为 ready 的当前 owner。
5. 同一 `(sessionId, localId)` 最多一行；重复发送必须返回同一持久化 receipt。
6. provider handoff 采用有序 at-least-once；没有模型侧幂等键时不宣称 exactly-once。
7. 只有 freshness 内的健康证明可直接判 online；PID 存在不等于事件循环和输入通道活跃。
8. 一个 daemon 管理的 session 在任一时刻只允许一个 releaseId 和一个 input owner。

## 7. 最小完整生产方案

### 7.1 A：App 到 Server 的持久化确认

复用现有 `localId` 与唯一索引，不新增服务端消息存储。

1. Server 的 `socket.on('message')` 接收 Socket.IO ACK callback。
2. Server 在访问数据库前校验 `sid/message/localId`：session 必须归属当前 account，`localId` 必须是无控制字符的 1–256 字节字符串，base64 密文不得超过现有恢复校验使用的 4 MiB；失败返回明确 ACK error。
3. 先按 `(sessionId, localId)` 查询：已存在则返回该行 receipt；不存在才在事务内分配 seq、创建消息，并在提交后返回 receipt，避免幂等重试消耗无效序号。
4. 跨连接并发撞唯一约束时，捕获唯一冲突并回查已有行，仍返回同一 receipt。
5. ACK 结构固定为：

```ts
type MessagePersistenceAck =
  | { ok: true; id: string; seq: number; localId: string; createdAt: number }
  | { ok: false; code: 'invalid' | 'not_found' | 'forbidden' | 'internal' };
```

6. App 改用 `emitWithAck`。`submitted=true` 只在 receipt 校验通过后返回。
7. App 必须先持久化 pending 状态，再插入乐观消息，最后 emit。每个 session 只保留一个 `pendingSubmission` 槽，包含 stable `localId`、已加密 record 与创建时间；不额外复制明文。现有持久草稿在 ACK 前保留并锁定为该 submission，收到 ACK 后才清除。连接恢复时以同一 localId 重试，不能生成新 ID。
8. ACK 超时显示“确认未知”，不显示“已发送”，也不盲目创建新消息。用户显式重试仍复用同一 pending submission；该 session 在确认完成前不接受第二条发送，以保持 bounded one-slot 语义。
9. 乐观消息在收到 receipt 后用服务端 `id/seq/createdAt` 校正；发送连接被 `skipSenderConnection` 排除不再造成永久本地身份。

这不是第二消息权威：pending slot 只是 bounded sender outbox，Server 行仍是唯一交付事实；限制为每 session 一个可避免再造通用队列。

### 7.2 B：重新定义 input-ready

复用当前 transport state 枚举，修正状态转换，不引入第二个 readiness 状态机。

精确恢复的转换必须是：

```text
connecting
  → reconciling
      ├─ socket connected
      ├─ candidate identity registered (not ready)
      ├─ onUserMessage consumer registered
      ├─ exact provider thread resumed
      └─ initial persisted window resolved
  → lifecycle running commit
  → connected (input-ready commit)
```

具体规则：

- `handleSocketConnect()` 在 `initialRestorePending` 时只能保持 `reconciling`，不得发布 `connected`。
- 增加只表达底层 Socket 握手完成的一次性 `waitForSocketConnected()`；它不写 transport state、不被 Daemon/UI 消费，只供初始/重连查询启动。保留公开 `waitForConnect()` 的 input-ready 语义，避免查询与 connected 互相等待。
- provider ready 只完成一个门槛，不得直接解析 Daemon 的 spawn/open。
- 持久窗口查询成功后按 server seq 合并离线行与 socket buffer，但只形成 pending queue；必须等 lifecycle running 与 transport connected 顺序提交完成后才 drain 到模型入口。
- 查询的单次网络超时可保持 3 秒，但不能“警告后永久跳过离线窗口”。使用总预算有界的恢复策略：3 次、退避 1s/2s、总墙钟不超过 15 秒。
- 总预算失败时 restore 明确失败并保持 archived；Daemon/App 显示可重试，不得把当前通道标成 connected。
- Socket 建立并验证 exact Happy session 后立即向 Daemon 注册 `reconciling` candidate identity，携带 PID/processStartedAt，但不带 `readyProviderSessionId`；它只推进 15 秒 identity deadline，不得解析 spawn/open。
- consumer 注册、provider 恢复和窗口查询可并行；最终 gate 先提交 lifecycle，再统一提交 connected，因此没有不必要的串行延迟，也没有两种 ready 顺序。
- 普通重连可按 anchor 恢复；无法证明窗口完整时同样 fail closed，不能静默丢历史输入。
- 新建 session 也走同一个 gate，只是初始持久窗口为空；不能为 fresh start 保留另一套 ready 定义。

### 7.3 C：生命周期与精确恢复提交

Codex、Claude、Gemini、ACP 最终应共享同一 lifecycle helper，先修 Codex 现场链路，再消除各 backend 漂移。

1. Happy graceful close/hard kill 提交 archived 时必须等待 `updateMetadata(..., { rejectOnServerError: true })` 成功，再发送 death/close；XC `@stop` 不改变 Happy lifecycle。
2. 精确恢复期间保持 archived，不提前显示 running。
3. consumer、provider、持久窗口三个候选门槛全部成功后，transport 仍保持 `reconciling`，先执行一次有界 metadata CAS/update：

```ts
const { archivedBy: _archivedBy, archiveReason: _archiveReason, ...rest } = current;
return {
  ...rest,
  lifecycleState: 'running',
  lifecycleStateSince: now,
  claudeSessionId: exactProviderId,
  version: currentCliVersion,
  hostPid: process.pid,
};
```

4. 必须通过对象重建明确移除归档字段，不能设置 `undefined` 后假定序列化会删除旧字段。
5. 不直接使用当前无 deadline 的 `updateMetadata()`。为 `ApiSessionClient` 增加 deadline 参数，使用 `socket.timeout(remaining).emitWithAck`，沿用 metadata version CAS，在固定尝试数和总预算内刷新冲突版本；Server 的 invalid/not-found/error 每条分支必须 callback。
6. 生命周期提交总预算固定为 5 秒；失败则 restore 失败、关闭候选进程、保留 archived，不能无限 backoff。
7. metadata 成功后才发布 transport `connected`、写首个健康证明、启动 `session-alive`，最后再次调用 `notifyDaemonSessionStarted()`，这次必须携带 exact provider ID 与 connected health；只有这次 final registration 能解析 Daemon spawn/open。
8. 不创建新 Happy session，不改变 session encryption key，不拆分历史。

### 7.4 D：低成本活性证明

恢复 10 秒/30 秒语义，但不恢复旧的高成本完整 webhook 心跳。

- 完整 session registration：只在启动、provider/lifecycle/owner/state 变化时发送。
- 轻量 health receipt：每 10 秒只原子刷新现有本地 transport-health 文件，字段为：

```ts
{
  sessionId,
  pid,
  processStartedAt,
  generation,
  state,
  providerSessionId,
  releaseId,
  updatedAt
}
```

- freshness 为 30 秒，允许既有 5 秒 clock skew。
- fresh + exact identity + `connected`：打开立即成功，不发 `SIGCONT`。
- stale/unknown：只做一次有界 ping/proof；generation 必须前进。失败即 offline/stale，交给显式 restart，不自动 hard kill 非 daemon-owned 进程。
- heartbeat 只在 `connected` 时运行，进程关闭时停止；写临时文件后 rename，避免半写。
- 日志只记录状态转换、stale、probe 和错误，不记录每次健康刷新，更不重复打印完整 session metadata。

### 7.5 E：Server 恢复事务、deadline 与补偿

`tryRestoreSession()` 必须由 TTL 锁改为同一 Server 路由 owner 内的 per-session in-flight Promise。
Server map 负责合并同进程触发；Daemon 在实际 spawn 边界继续用现有 tracked-session/exact-identity
检查强制“最多一个 child”，两者是不同边界的防护，不是两个 lifecycle authority：

1. 第一条持久消息创建 `{ sessionId, restoreRequestId, startedAt, promise }`；并发触发复用同一 promise，不再次 spawn。
2. Daemon 收到 restore 时先检查 exact ready/candidate child；ready 直接返回，candidate 返回/等待同一启动结果，任何新 request 都不得越过该检查再次 spawn。
3. `session-alive` 不得删除 in-flight restore；只有事务 `finally` 可以释放。候选进程在 final input-ready 前不得发送 `session-alive`。
4. Server restore RPC deadline 固定 60 秒，覆盖 Daemon 15 秒 identity + 35 秒 provider/input gate + 5 秒 lifecycle commit，并留出传输余量；Daemon 内部各门槛仍保留更小的独立 deadline。
5. Server 一旦发出 restore RPC，就预先把请求中的 exact `sessionId` 加入补偿集合；不能等成功 ACK 后才记录。
6. transport timeout、typed failure、identity mismatch、lifecycle failure或 Server `active=true` 提交失败，都用同一 `restoreRequestId + sessionId` 调用 rollback。Daemon rollback 必须同时匹配 expected/current Happy identity 与 requestId，终止候选并拒绝旧请求误杀新 owner。
7. late ACK 只记录为 stale result，不能再更新 `Session.active`；Server 只有收到 requestId 一致的 final ready ACK 后才能写 `active=true`、刷新 cache 并广播 presence。
8. `Session.active/activityCache` 只作为 Server 路由与 presence 投影；加密 metadata lifecycle 是用户可见持久状态。二者不是两个 lifecycle authority，active 只能由 final ready 派生，session-end/失败则回落 false。

### 7.6 F：停止语义与来源审计

| 操作 | 作用 | Happy 生命周期 | Happy 进程 |
|---|---|---|---|
| abort | 中断当前 model turn | 保持 running | 保持 |
| XC safe stop（`@stop`） | 请求 XC 当前任务安全停止 | 保持 running | 保持 |
| graceful session close | Daemon drain 或用户正常关闭 Happy 会话 | 进入 archived | flush 后退出 |
| hard kill | 用户明确终止该 Happy 会话 | 进入 archived | abort、flush、close、退出 |

- `@stop` 保持现有 safe-stop 路由，不映射 hard kill。
- hard kill 请求携带 `requestId` 和客户端声明的 `source`；Server 日志补充认证 account/device/connection 类型与目标 session。
- CLI 只信任服务端鉴权后的 RPC，不使用客户端自报身份作为权限依据。
- 相同 requestId 幂等；同一会话重复 kill 只产生一次 lifecycle 转换。
- 当前只需结构化日志和关联 ID，不增加 durable audit 数据库。若未来有合规留存要求，再单独立项。

### 7.7 G：不可变构建与受控切换

1. 停止在活跃 daemon/children 使用的目录中原地覆盖 `dist`。
2. 每次构建在 `/private/tmp/xc-disposable/<unique-root>` 的唯一临时输出中生成带 `releaseId` 的包，长任务持续刷新直属根 mtime；门禁通过后再通过现有安装链路一次性安装为不可变运行版本，不把活动源码目录当发布目录。
3. Daemon state、session metadata 和 health receipt 都暴露同一 releaseId；版本一致但 bundle 不同也能识别。
4. 发布采用：构建一次 → 最小门禁 → Daemon drain → 逐个优雅停止 daemon-owned session → 启动新 Daemon → 按需精确恢复。
5. terminal-owned session 不自动杀；标记旧 release，要求用户显式重启。
6. 回滚切回上一不可变 release，重复受控 drain/restart；禁止用源码 reset 代替运行时回滚。

### 7.8 H：最小公共协议矩阵

本方案改变 App→Server ACK、Server→Daemon restore/rollback 和 CLI→Daemon candidate/final
registration，触发 `public-abi-or-persistent-format` 边界。实现批次只建立一个机器矩阵：

`contracts/happy-input-reliability-v1.matrix.json`

- schema：`contract-first-module-gate/v2`
- contractProfile：`contract-first-minimal-boundary/v1`
- riskTriggers：仅 `public-abi-or-persistent-format`
- publicApis：`message-persistence-ack`、`server-restore-session-v1`、`server-rollback-restored-session-v1`、`daemon-session-registration-v1`
- lifecycleTransitions：`reconciling candidate → running metadata → connected final → server active`
- budgets：4 MiB ciphertext、5 秒 metadata commit、15/35 秒 Daemon 两阶段门禁、60 秒 Server RPC
- provenanceFields：`sessionId`、`restoreRequestId`、`pid`、`processStartedAt`、`providerSessionId`、`releaseId`
- evidence：实现中保持 `repair` 和真实 finding 数；所有边界测试通过后才改 `approval/openFindingCount=0`

矩阵由现有 Vitest 边界测试直接读取并逐行断言，不增加第二份设计或 review authority。当前 Happy
仓库没有 `.agents/gates/contract-first/contract-first-module-gate.mjs`，因此本文不伪造该 gate 的
approval receipt；本仓完成声明只能使用仓库原生可执行测试证据。若将来安装标准 gate，再在同一
矩阵上执行，不复制矩阵。

## 8. 代码落点与实施顺序

### Phase 0：冻结与可复现证据

- 冻结相关文件的 scoped diff 指纹。
- 给一次复现绑定 `localId + restoreRequestId + health generation + releaseId`。
- 禁止边运行边重建同一 `dist`。

验收：能够从 App 提交一路关联到 Server row、Daemon restore、CLI handoff 和 provider turn。

### Phase 1：公共矩阵、服务端 ACK 与 App pending submission

写集：

- `packages/happy-server/sources/app/api/socket/sessionUpdateHandler.ts`
- `contracts/happy-input-reliability-v1.matrix.json`
- 扩展 `packages/happy-server/sources/app/api/socket/sessionUpdateHandler.spec.ts`
- `packages/happy-app/sources/sync/apiSocket.ts`
- `packages/happy-app/sources/sync/sync.ts`
- `packages/happy-app/sources/-session/SessionView.tsx`
- `packages/happy-app/sources/sync/persistence.ts` 及对应 storage type/test

验收：服务端 commit 前 App 不报成功；ACK 丢失后同 localId 重试只产生一行；App 重启后 pending slot 仍可确认。

### Phase 2：input-ready、恢复事务与 lifecycle 单次提交

写集：

- `packages/happy-cli/src/api/apiSession.ts`
- `packages/happy-cli/src/utils/fetchPendingMessages.ts`
- `packages/happy-cli/src/codex/runCodexAppServer.ts`
- `packages/happy-cli/src/api/apiMachine.ts`
- lifecycle shared helper 及 Codex/Claude/Gemini/ACP 调用点
- `packages/happy-cli/src/daemon/run.ts`
- `packages/happy-server/sources/app/api/socket/sessionUpdateHandler.ts`
- `packages/happy-server/sources/app/api/socket/sessionUpdateHandler.spec.ts`

验收：raw socket wait 不与 input-ready 自锁；candidate 只推进 identity；restore 窗口未完成时
Daemon open 不成功；完成后同一 Happy/provider ID 进入 running；归档字段已清除；并发/超时只
留下零个或一个 final owner，绝不留下幽灵候选。

### Phase 3：轻量健康证明

写集：

- `packages/happy-cli/src/api/sessionTransportHealth.ts`
- `packages/happy-cli/src/api/apiSession.ts`
- `packages/happy-cli/src/daemon/run.ts`

验收：fresh 会话打开无探测延迟；冻结事件循环后 30 秒内变 stale；日志量不随 10 秒心跳打印完整元数据。

### Phase 4：release 一致性、发布和文档

- 在构建产物生成 releaseId，并在 daemon/session health 中传播。
- 受控重启全部 daemon-owned 会话，盘点 terminal-owned 旧会话。
- 删除或更新所有把“provider ready”等同“input ready”的文档与提示。

验收：运行进程只包含目标 releaseId；恢复/输入门禁通过；可按上一 release 回滚。

## 9. 测试矩阵

### 9.1 单元与合同测试

| 用例 | 预期 |
|---|---|
| Server 首次 localId | commit 后 ACK 含 id/seq/localId |
| 同 socket 重复 localId | 返回原 receipt，仅一行 |
| 两个 socket 并发同 localId | 唯一冲突被回查，两方 receipt 相同 |
| Server handler 抛错 | ACK 为显式 error，App 不清 pending |
| localId 非法或密文超过 4 MiB | 入库前拒绝，不分配 seq |
| App 断网发送 | 状态 pending，不显示 submitted；重连复用 localId |
| App 收到 ACK | optimistic id/seq 被权威 receipt 校正，pending 清除 |
| raw Socket 已连、transport 仍 reconciling | 初始恢复查询可启动，公开 `waitForConnect` 仍不解析 |
| initial restore socket 先连 | transport 仍为 reconciling |
| candidate registration | 只推进 identity deadline，不解析 Daemon restore |
| consumer/provider/query 任一未完成 | Daemon open 不成功 |
| query 前两次超时、第三次成功 | 只合并一次并按 seq drain |
| query 超出总预算 | restore 失败且 lifecycle 保持 archived |
| graceful close/hard kill metadata 写失败 | 不宣称已干净归档，返回可见错误 |
| metadata callback 缺失或冲突持续 | 5 秒内失败，不无限 backoff |
| resume 成功 | running 且 archive 字段不存在 |
| 两条消息并发触发 inactive session | 复用同一 in-flight，只 spawn 一次 |
| `session-alive` 到达 reconciling candidate | 不清 in-flight、不广播 active |
| Server 等待 59 秒、Daemon 第 50 秒 final ready | restore 成功，不提前 timeout |
| Server 第 60 秒 timeout、Daemon late ACK | rollback 请求中的 candidate；late ACK 不写 active |
| rollback requestId 不匹配当前 owner | 拒绝终止新 owner |
| fresh health | 不发送 SIGCONT |
| stale health | 一次 probe；generation 不前进则 offline |
| PID 复用 | processStartedAt 不匹配，拒绝旧证明 |
| releaseId 不一致 | 受控 restart，不复用旧 child |

### 9.2 真实跨进程场景

所有可重建产物在唯一 `/private/tmp/xc-disposable/<run>` 下执行：

1. 创建会话 → hard kill → 在 App 只发送一条唤醒输入 → 精确恢复 → 同一 Happy ID/provider ID → 模型只接收一次。
2. 让消息 GET 连续两次超时但在总预算内恢复，验证 Daemon 不提前返回 ready。
3. 让消息 GET 超出预算，验证 UI 保持 stopped/retryable，首条消息仍留在 Server 且下次恢复可重放。
4. 冻结 CLI 事件循环但保留 PID，验证 30 秒后 Daemon 不再判 online。
5. ACK 在 DB commit 后丢包，App 重连用相同 localId 获取同一 receipt。
6. 同机启动旧 release 会话，再部署新 release，验证 daemon-owned 旧进程被 drain，terminal-owned 进程只告警不误杀。
7. 发出 abort、XC safe stop、graceful session close、hard kill，验证四种路径的生命周期、退出行为与 requestId 日志。
8. 同时发送两条唤醒消息并把 provider readiness 延迟到 20 秒以后，验证 Server 不重复 spawn、
   不提前失败；再制造 60 秒 timeout，验证 exact candidate 被补偿且 late ACK 不激活 presence。

### 9.3 建议命令

按改动边界运行最小集合，不在当前文档任务中执行。全部命令都在
`/private/tmp/xc-disposable/<unique-run>/happy` 的隔离副本中运行，避免把可重建 `dist`、
测试缓存或中间产物写入活动工作区；以下命令均从隔离副本的仓库根执行：

```bash
# Happy CLI
yarn --cwd packages/happy-cli typecheck
yarn --cwd packages/happy-cli vitest run src/api/apiSession.test.ts src/api/apiSessionMessage.test.ts \
  src/daemon/run.test.ts src/codex/__tests__/runCodexAppServerE2E.test.ts

# Happy Server
yarn --cwd packages/happy-server vitest run sources/app/api/socket/sessionUpdateHandler.spec.ts

# Happy App
yarn --cwd packages/happy-app typecheck
yarn --cwd packages/happy-app vitest run sources/sync/sync.test.tsx \
  sources/-session/SessionView.test.tsx
```

其中 App 两个测试文件属于 Phase 1 必须新增的真实测试；Server 扩展现有 spec。三个测试都必须
读取同一机器矩阵的相关边界行，不得创建空测试壳或仅做 source-text 断言。

## 10. 可观测性与现场判定

每条输入至少输出一次结构化阶段事件，内容不含明文消息：

```text
message_persisted(sessionId, localId, seq, serverRequestId)
restore_requested(sessionId, restoreRequestId, source)
restore_coalesced(sessionId, restoreRequestId, localId)
candidate_registered(sessionId, pid, processStartedAt, restoreRequestId)
provider_ready(sessionId, providerSessionId, restoreRequestId)
input_ready(sessionId, generation, releaseId, restoreRequestId)
message_handoff(sessionId, localId, seq, restoreRequestId)
lifecycle_committed(sessionId, from, to, requestId)
restore_rolled_back(sessionId, restoreRequestId, reason)
```

指标：

- `message_persist_ack_latency_ms`
- `restore_to_provider_ready_ms`
- `restore_to_input_ready_ms`
- `pending_window_retry_total`
- `input_handoff_lag_ms`
- `stale_health_total`
- `probe_timeout_total`
- `lifecycle_invariant_violation_total`
- `mixed_release_session_total`
- `restore_coalesced_total`
- `restore_late_result_total`
- `restore_rollback_failed_total`

日志要求：localId/requestId 可关联，消息正文不可记录；正常 heartbeat 不逐次记录；错误必须有有界原因码。

## 11. 迁移、兼容与回滚

### 11.1 兼容顺序

1. 先部署 Server ACK；它是现有 `message` 事件的加法扩展，旧 App 可忽略 callback。
2. 再发布 App receipt/pending slot；该版本要求 Server ACK 能力。旧 Server 不返回 ACK 时必须进入可见失败/确认未知，不能静默退回 fire-and-forget。
3. Server/CLI/Daemon 的 restoreRequestId、candidate/final registration、rollback 和 deadline 必须同一 release 协调部署，并 drain 旧 daemon-owned child；禁止新 Server 对旧 Daemon 启用事务协议。
4. lifecycle metadata 不需要数据库迁移，只规范已有字段的提交和清除。

### 11.2 回滚

- App 回滚到上一 release 前，Server 保留 ACK 兼容。
- CLI/Daemon 必须成对回滚并重新 drain/restart，不允许新 Daemon管理旧 health 语义的 child。
- Server 必须与 CLI/Daemon 协议批次一同回滚；回滚期间先停止新 restore admission，再 drain，避免跨版本 requestId 丢失。
- Server 数据不回滚、不删除消息；`localId` 唯一索引保持。
- 已存在 archived/running 冲突会话用一次只读盘点生成清单，再由精确恢复或明确停止修正；禁止批量猜测状态。

## 12. 明确不做

- 不修改 Codex 或其他模型客户端来弥补 Happy readiness。
- 不新增第二个消息数据库、全局 scheduler 或隐藏状态权威。
- 不用无限重试掩盖 restore 失败。
- 不把 Socket connected、provider ready、PID alive 单独当 input-ready。
- 不以 TTL 锁代表 restore 所有权，不让 `session-alive` 释放恢复事务。
- 不恢复每 10 秒完整 metadata webhook。
- 不在 fresh 会话打开时无条件发送 `SIGCONT`。
- 不把模型 handoff 宣称 exactly-once。
- 不通过新建 Happy session 绕过旧 session 生命周期问题。
- 不以 `git reset`、覆盖源码或原地重建活跃 `dist` 作为发布/回滚方案。

## 13. 风险与残余限制

| 风险 | 处置 |
|---|---|
| Server ACK 已提交但 App 未收到 | stable localId + persisted pending slot + 幂等重试 |
| provider 已部分执行、进程在确认前崩溃 | 明示 at-least-once 恢复警告；无模型幂等键时无法彻底消除 |
| 网络断开超过健康 TTL | 标 stale 后显式恢复，不误判 online |
| terminal-owned 旧会话无法自动 drain | 告警并要求显式重启，不扩大 daemon 写权/杀进程权 |
| 恢复窗口固定条数不足以找到处理边界 | 当前校验 fail closed；后续若真实负载证明不足，再单独设计 cursor，不预先扩展 |
| 手机 release 不可识别 | App/CLI/Daemon 都展示 releaseId 后再做现场归因 |
| Server restart 会丢失进程内 in-flight map | Daemon spawn 边界先检查现有 exact ready/candidate child；新请求附着或返回 in-progress，不盲目再次 spawn |

## 14. 实施完成定义

只有以下条件全部满足才能宣称修复完成：

- R1–R8 的测试全部通过，且真实跨进程场景 1–8 无遗漏。
- 现场不能再出现 `running + archivedBy/archiveReason` 或 `archived + fresh connected owner`。
- App 的 submitted 只来自 Server receipt；代码中无该路径的裸 `send('message')`。
- initial restore 时不存在 Socket 首连直接发布 connected 的路径。
- raw socket wait 与 input-ready wait 分离且无依赖环；candidate/final registration 的消费者测试通过。
- 20/30 秒旧 timeout/TTL 不再控制 restore；60 秒 deadline、requestId 合并和 timeout rollback 均有边界测试。
- 健康判断恢复 TTL，且 24 小时正常运行的 heartbeat 日志/CPU 不出现原完整 webhook 放大。
- daemon-owned 活跃会话 releaseId 一致；旧 release 盘点为零。
- 旧自动恢复文档已明确标为历史方案，不再与当前设计竞争权威。

## 15. 设计闭环审计

审计透镜固定为：端到端交付与顺序、生命周期/停止/恢复、活性/运维/混合版本、证据/最简性/可验证性。

本轮增量 Self-review 共使用 10 次有界读取/搜索调用，时间为 10:31:22–10:38:04 CST
（6 分 42 秒），未委派子智能体、未被用户中断，并在第 5 个真实发现处停止研究；随后只执行一轮
文档修正与无新研究的反向验证，符合停止条件。

| 计数器 | 值 | 说明 |
|---|---:|---|
| omittedObligations | 0 | 用户输入、恢复、停止、活性、版本一致性和审计均有落点 |
| unsupportedClaims | 0 | 现场未证事实均标记为 Unknown 或 Inference |
| unresolvedDecisions | 0 | ACK、恢复失败、TTL、生命周期提交和 rollout 均已定案 |
| unverifiableOutcomes | 0 | 每项承诺均有单测或跨进程验收 |
| orphanElements | 0 | 每个新增字段/状态都有消费者和验收 |
| duplicateAuthorities | 0 | Server 消息行、CLI readiness、metadata lifecycle、health 各自唯一 |
| redundantStates | 0 | 复用 transport/lifecycle 枚举；pending slot 只表达发送确认 |
| speculativeMechanisms | 0 | 不预建 cursor、审计库或第二队列；只补当前证据要求的边界 |

historicalArtifact: true
supersededBy: docs/analysis/happy-remote-baseline-stabilization.md
