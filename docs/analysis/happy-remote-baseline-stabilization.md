# Happy 客户端输入与 Daemon 稳定化方案（CLI-only）

> 状态：Happy CLI 源码已按本方案完成；尚未部署或重启运行中的会话/Daemon
> 日期：2026-08-10
> 对照基线：`origin/compat/pre-v3-clean=adc3a68a97a82928e5edb7d5afc5b97e9f5c3037`
> 唯一产品写集：`packages/happy-cli/**`
> 明确排除：`packages/happy-app/**`、`packages/happy-server/**`

## 1. 最终决策

只修 Happy CLI 与其 Daemon。App 和 Server 作为现有外部系统使用，不修改、不新增协议要求，也不把
它们当前工作树中的改动计入本方案证据。

客户端只保留一条输入链：

```text
Server 已持久消息行
  -> ApiSessionClient 每会话内存 FIFO
  -> 已注册的 provider callback
  -> provider 现有 MessageQueue2
```

普通输入不得等待 XC、Daemon HTTP、健康文件、metadata ACK、恢复 RPC 或灰色提示。Daemon 只负责
本机 provider 进程的启动、登记和恢复；它不是消息真源，也不进入普通输入热路径。

不新增 App pending store、Server ACK/idempotency、事件池、requestId 补偿、candidate 状态、第二消息库、
`@@@` 强制通知或其他兼容协议。

## 2. 当前事实与能力边界

### 2.1 已验证事实

- Server 现有消息行已经提供 `id`、`seq`、`localId`、`createdAt` 和加密 `content`；CLI 可通过现有
  Socket `new-message` 与现有消息查询读取同一权威。
- `ApiSessionClient` 是解密、Socket 重连和 provider callback 的当前客户端 owner。
- Claude、Codex、Codex App Server、Gemini 和 ACP 最终都把普通输入同步压入已有 `MessageQueue2`；
  模型执行本身不应成为 callback 完成条件。
- 对照基线把 XC/Daemon 异步工作串在 `onUserMessage` 前，并在异步结果未知时推进观察游标；这是首条
  输入静默丢失和长延迟的首个客户端分歧。
- `sendSessionEvent()` 当前只做本地加密后 Socket emit，断线时进入有界内存输出队列；它不需要新增
  ACK 协议才能作为非阻塞灰色提示。

### 2.2 客户端可以保证

1. 已经存在于 Server 消息表且进入 CLI 可见窗口的用户行，不会因 XC/Daemon 慢而延后 provider 接纳。
2. 同一进程内，实时更新、恢复查询和 Socket 重连按 `seq` 合并，同会话 FIFO，重复行不重复入队。
3. provider callback 成功返回前不推进已接纳锚点；同步拒绝留下队首并产生可见终态。
4. 一个会话的查询、Daemon 或 provider 故障不阻塞其他会话。
5. provider 已安装输入 callback 后才向 Daemon 报告 input-ready。
6. 灰色“CLI 已接收”提示发送失败不影响 provider callback。

### 2.3 客户端不能保证

- App 点击发送到 Server 落库之前的可靠性、乐观 UI、MMKV 草稿或手机端“已发送”时机。
- Server 是否 ACK、是否幂等写入、是否自动唤醒 inactive session，或 Server/App 的端到端延迟。
- provider 进程在“已压入模型队列、尚未更新内存锚点”的瞬间崩溃时 exactly-once。客户端无新增
  持久接纳回执，因此跨进程恢复只能是显式的 at-least-once。
- App/Server 当前脏改动的正确性、部署状态或兼容性。

以上边界不能通过客户端状态、超时或重试伪装为已解决。

## 3. 最小状态与唯一 owner

| 事实 | owner | 唯一表示 | 生命周期 |
|---|---|---|---|
| 消息内容与持久顺序 | 现有 Server | 消息行 `id + seq + encrypted content` | Server 保留 |
| 待交付客户端输入 | `ApiSessionClient` | 一个 per-session 内存 FIFO | callback 接纳后删除 |
| 已接纳位置 | `ApiSessionClient` | 一个 `lastAccepted = {id, seq}` | 进程生命周期 |
| 是否正在 drain | `ApiSessionClient` | 一个布尔值 | drain 调用期间 |
| Socket 状态 | 现有 transport | 现有 transport state | Socket 生命周期 |
| 断线待发 agent 输出 | `ApiSessionClient` | 现有有界内存输出 FIFO | emit 后删除 |
| provider 进程归属 | Daemon | 现有 tracked-session 记录 | 进程退出后删除 |
| Daemon 重登记 | `ApiSessionClient` | 一个 timer + 至多一个 in-flight Promise | provider 生命周期 |

禁止增加可由上述事实推导的 `accepted/rejected/retryable` 持久状态、单独 recovery queue、seen ring、
turn token、transport-health receipt、heartbeat generation、candidate/final 双身份或事件文件。重登记的
timer/Promise 只解决跨平台 Daemon 重启，不能承载输入、健康或投递状态。

## 4. 精确客户端行为

### 4.1 普通输入

1. Socket/update 或恢复查询取得一条持久行。
2. 校验行身份和加密 envelope，解密为 `UserMessage`。
3. 若 `seq <= lastAccepted.seq`，视为已接纳重放；若与当前 FIFO 的 `id/seq` 相同，视为待处理重放；
   身份冲突 typed fail-closed。
4. 按 `seq` 插入唯一 FIFO。callback 未注册时仅保留，不推进锚点。
5. 有 callback 且当前不在重连合并期时，从队首同步调用 callback。
6. callback 正常返回表示已交给 provider 的现有队列或已由本地命令处理；随后删除队首并推进
   `lastAccepted`。callback 抛错则保留队首、停止 drain、发送一次可见错误，不让后续消息越过。

provider callback 重新收敛为同步接纳接口：不得在返回前等待模型、XC、Daemon、网络查询或 metadata。
异步 bang 命令可以在 callback 内启动自己的任务，但“已调度该命令”即完成接纳。

### 4.2 灰色提示与输出

- 对普通模型输入，在 callback 前调用一次现有 `sendSessionEvent({type:'message', ...})`。
- 该调用不得 `await`、不得查询持久化确认、不得创建独立 Socket、不得重试；失败只记本地 debug。
- 断线时沿用唯一有界 agent 输出 FIFO；连接恢复后按原顺序 emit。
- 删除 `@@@` 及任何“强制模型通知”解释。单个 `@` 是普通模型输入，`@@` 才是控制台菜单。

灰色提示仅证明“CLI 已开始本地交接”，不证明 Server 已再次落库或模型已开始生成。

### 4.3 初始恢复与重连

- 新会话：先安装 callback，随后正常 drain。
- 恢复会话：callback 尚未安装时启动现有消息查询；实时 Socket 行与查询行都进入同一个 FIFO；查询
  完成并排序去重后再安装 callback。无需 `pausePersistedInputDelivery` 或第二 recovery buffer。
- 在线重连：transport 进入现有 `reconciling` 状态，同一个 FIFO 暂停 drain；用 `lastAccepted` 查询、
  合并，成功后恢复 drain。
- 查询使用三个有界尝试（每次连接和查询各至多 10 秒）与现有行数/字节预算。耗尽后保持该会话不可交付并显示恢复错误；不得推进
  锚点、丢弃 FIFO 或把失败伪装为 ready。
- 当前 Server 只提供有限 recent window 时，无法证明连续性就明确失败；客户端不得猜测缺口。

跨进程恢复若重新提交可能已部分执行的队首，只显示一次 at-least-once 提示；不增加持久状态来伪造
exactly-once。

### 4.4 `@stop`

精确的人类 `@stop` 继续使用现有 2 秒有界本地安全停止；它不调用模型，也不等待 XC 普通输入流程。
由于普通 callback 只做同步入队，`@stop` 不会被前一条输入的外部 I/O 阻塞。工作区不存在该停止
能力时，返回一个本地可见终态，不把控制命令误送给 provider。

## 5. Daemon：冷路径、单阶段登记

1. provider 创建 `ApiSessionClient`、完成必要恢复、安装 callback。
2. provider 只在此时调用一次现有 `/session-started`，表示 input-ready；不发送 candidate 登记。
3. daemon 启动的 provider 若在一个总 startup deadline 内未完成该调用，Daemon 终止该精确 child 并
   返回失败。terminal 启动不因 Daemon 缺失而失败。
4. final 登记成功后，每个 provider 使用一个低频 timer 重发同一份登记；上一调用未结束时直接跳过，
   不排队、不重试、不影响输入。该机制跨平台恢复 Daemon 重启后的进程归属。
5. Daemon 只接受 PID、Happy session ID 与 provider session ID 都匹配的登记；冲突明确拒绝。
6. provider 退出或 terminal transport failure 走一个现有有界 teardown，移除 tracked session；不创建
   zombie/unknown/on-demand 状态机。

`session-alive` 仍按现有协议发给 Server，但不作为 Daemon input-ready 证据，也不修改 Server。

## 6. 删除、保留与写集

### 6.1 删除或回退

- `ApiSessionClient.projectInputQueue` 以及普通输入中的 `runProjectSessionInput`、Watch ensure、Daemon
  refresh、startup await、turn token/turn-end 串联。
- 单独的 recovery buffer、seen ring、restore pause flag；统一进一个 FIFO 和一个锚点。
- `sessionTransportHealth` receipt 文件、health heartbeat、generation/digest 及 Daemon 对其的判断。
- candidate/final 双阶段、requestId 补偿和由 metadata ACK 决定输入接纳的路径。只保留一个不排队的
  final 重登记 timer，用于跨平台 Daemon 重启。
- `@@@` 强制投递和与 Mail/XC 绑定的 Happy 宿主语义。

### 6.2 保留

- Server 消息行和现有 Socket/查询 API，不改 schema。
- provider 已有 `MessageQueue2`，不建第二 provider queue。
- 有界 agent 输出 FIFO、Socket transport state、现有加密格式。
- 控制台改动：单个 `@` 透传、`@@` 菜单、现有 `@a/@u/@h/...` 别名。
- Daemon 现有本机 control endpoint、进程发现、精确 PID/identity 校验和有界 child teardown。

### 6.3 允许修改的产品文件

- `packages/happy-cli/src/api/apiSession.ts`
- `packages/happy-cli/src/api/sessionMessageRecovery.ts`（仅保留纯校验/合并算法）
- `packages/happy-cli/src/utils/fetchPendingMessages.ts`
- `packages/happy-cli/src/daemon/{run.ts,controlClient.ts,controlServer.ts,types.ts}`
- 五个 provider 接线文件及对应 focused tests
- `packages/happy-cli/src/commands/bang/dispatcher.ts` 及测试

实现时允许删除已被替代的 Happy CLI 文件。禁止修改 App、Server、XC、公共协议或其测试；当前这些
目录的脏改动既不回滚也不吸收到本批次。

## 7. 实施顺序

1. **冻结 scope**：记录 App/Server 当前 diff，只作为排除清单；后续 scoped diff 必须只有 CLI 与本文档。
2. **恢复热路径**：先删除 XC/Daemon/metadata 等前置等待，再实现单 FIFO + 同步 callback 接纳。
3. **统一恢复**：初始恢复和 reconnect 共用 FIFO/锚点/纯合并算法，删除第二 buffer 和 seen 状态。
4. **简化 Daemon**：单阶段 input-ready + 合并式低频重登记，删除 receipt heartbeat 和候选状态。
5. **保留控制台**：复核 `@`/`@@` 与现有别名，不混入输入可靠性状态。
6. **一次验证**：完整写集完成后运行 focused tests、CLI TypeScript、临时目录生产构建和 scoped diff 检查。

不做运行中 App/Server 部署，不重启其他会话，不提交或推送，除非用户另行要求。

## 8. 可执行验收

### 8.1 输入与恢复

1. callback 未注册时首条持久输入留在 FIFO；注册后交付一次。
2. 连续两条按 `seq` 同步压入 provider queue；后条不越过失败队首。
3. XC startup、Daemon HTTP 和 metadata Promise 永不完成时，普通 callback 仍在同一事件循环轮次被调用。
4. callback 同步抛错：锚点不推进、队首保留、错误可见。
5. query/live 同一行只交付一次；身份冲突 fail-closed。
6. reconnect 查询失败不释放 FIFO；成功后按序继续。
7. 超出 recent window 且无精确锚点时明确失败，不猜测连续性。
8. `@stop` 有界，单个 `@` 进模型，`@@` 打开菜单。

### 8.2 Daemon 与输出

1. provider callback 安装前的 `/session-started` 不存在；安装后只有一种 final 登记语义。
2. Daemon startup 超时终止精确 child；terminal provider 不等待 Daemon。
3. Daemon 重启后，下一个重登记 tick 恢复归属；Daemon 不可达时始终至多一个 in-flight 调用，且不依赖
   磁盘 receipt。
4. 灰色提示发送抛错不影响 callback；断线 agent 输出只进入现有有界 FIFO。
5. terminal transport 触发有界 teardown，PID 最终退出，后续 restore 可创建一个新 provider。

测试只模拟现有 App/Server wire 行为，不改它们，也不把 mock 当成端到端产品证明。性能验收只验证
“热路径无外部 await”的机制；在取得同机、同版本、同负载的真实数据前，不声明 0.2 秒或任何产品
延迟 SLO。

### 8.3 当前实现证据

- CLI TypeScript `--noEmit` 通过。
- 输入、恢复、Daemon、控制台、ACP 与 Codex 接线聚焦回归共 139 项通过。
- 最小性能合同门禁通过；合同只覆盖 Happy CLI，不执行 App/Server 测试。
- `pkgroll` 在 `/private/tmp/xc-disposable` 的源码副本中完成，未覆盖当前 `dist`。
- CLI 全量 Vitest 的输入相关用例全部通过；唯一失败是远端未修改的 Claude 安装路径测试，其断言未统一
  macOS `/var` 与 `/private/var`，且把已经存在的 Bun 可执行文件误判为应返回 `null`，不属于本写集。

## 9. 兼容、迁移和残余风险

- 本方案不改变 wire/schema，所以旧 App、旧 Server 与新 CLI 仍使用既有协议；这不等于证明旧端
  所有缺陷已修复。
- 旧 CLI 进程继续旧代码；新 CLI 只影响新启动/重启的会话。无需全量会话同时升级。
- 当前代码搜索确认 health receipt 的活动 producer/consumer 都在 Happy CLI/Daemon；历史 XC evidence
  不是 live consumer。实际删除仍须由 focused boundary test 证明 Daemon 只依赖 final 重登记；若实施时
  发现新的当前消费者，停止删除并报告边界，不新增兼容双写。
- Server recent window 无分页时，超长离线缺口仍会 fail-closed；客户端不能无损修复该 Server 能力。
- 跨进程 exactly-once 仍不可保证；若未来必须保证，需要单独授权持久接纳协议，不能偷偷加属性。

## 10. 双零评审

### 10.1 原方案五原则评分

| 原则 | 分数 | 当前证据 | 第一缺陷 |
|---|---:|---|---|
| 解耦/ownership | 3/10 | 写集同时含 App、Server、CLI | 违反本次客户端边界 |
| 配置/数据 authority | 4/10 | 同时设计 App pending、Server ACK、CLI FIFO | 把三层未实现状态混成完成承诺 |
| 性能/内存 | 4/10 | 普通输入去掉部分等待，但仍保留 heartbeat/多队列 | 无真实测量且热路径状态过多 |
| 扩展/维护 | 5/10 | provider 共用入口 | candidate、receipt、补偿协议增加分支 |
| 复用/删除/代码量 | 3/10 | 计划新增跨三包代码和合同 | 未先删重复状态与外围路径 |

合计：`19/50`。硬阻塞为 scope 越界和客户端无法兑现的端到端声明。

### 10.2 修订后评分

| 原则 | 分数 | 当前证据 | 剩余边界 |
|---|---:|---|---|
| 解耦/ownership | 10/10 | 单一 CLI 输入 owner；App/Server 固定外部边界 | 无 |
| 配置/数据 authority | 10/10 | Server 行唯一持久真源；CLI 仅临时 FIFO | 无 |
| 性能/内存 | 9/10 | 删除普通输入外部 await、周期 receipt 与重复队列 | 产品延迟须实施后实测 |
| 扩展/维护 | 10/10 | provider 复用同步 callback 约束和现有队列 | 无 |
| 复用/删除/代码量 | 10/10 | 删除多套状态，复用 Socket、查询、MessageQueue2 | 无 |

合计：`49/50`。当前 Happy CLI 源码与边界验证为 `PASS`；运行中的旧会话和 Daemon 仍执行旧构建，
必须在用户另行授权部署/重启后才会采用本实现。

```text
omittedObligations: 0
unsupportedClaims: 0
unresolvedDecisions: 0
unverifiableOutcomes: 0
orphanElements: 0
duplicateAuthorities: 0
redundantStates: 0
speculativeMechanisms: 0
```

resultGranularity: implementation-ready design
closureStatus: PASS
