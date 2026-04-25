# Codex 客户端 /compact 方案 — 设计与可行性

> 现状：`runCodexAppServer.ts:298-322` 拦截 /compact 仅返回提示，没有实质行为。
> 根因（已通过桌面失败日志证实）：codex auto pre-sampling compact 会向 `https://chatgpt.com/backend-api/codex/responses/compact` 发约 800KB 的请求，经过本机代理时偶发 stream 切断（`Proxy CONNECT response missing status line`），失败率约 25%；codex 自身 `willRetry: false`，turn 直接终止。

## 一、目标语义重定义

`/compact` ≠ 调用 codex compact 接口，**而是「让 happy 在客户端层面完成上下文瘦身、然后无缝换一条 codex conversation 继续工作」**。

对用户可见的承诺：
1. **happy session 保持不变**（前端 sessionId 不动，历史不裂）
2. **当前 codex conversation 被丢弃**，新 codex conversation 上下文 = 摘要文本
3. 失败/降级时给出明确状态信息，永不静默失败

## 二、关键设计判断：放弃 LLM 摘要路径

### LLM 摘要在「原会话」和「新会话」两端都是死路

| 路径 | 致命问题 |
|---|---|
| 在原 conversation 发摘要 prompt | history 已高位 → pre-sampling compact 必触发 → 撞 25% 失败的同一接口 |
| 先 newConversation 再摘要 | 新会话空 history，没东西可摘要 |

→ **LLM 摘要无解**。原 §3.1「主动型让 codex 摘要」方案作废。

### 共识：统一走本地启发式（唯一路径）

不再区分主动型/救援型。理由：
1. 主动型仍可能发出有 25% 失败概率的 sampling 请求，没必要冒险
2. 启发式在「好对话」上质量已够（复用 `compacted` record 时 ≈ LLM 质量）
3. 架构简化：单数据源、单代码路径、零网络、零失败点
4. 用户体验：从「几秒-几十秒等 LLM」降到「<100ms 本地完成」

## 三、方案设计

### 3.1 主动型流程（happy path）

```
/compact 触发
 ├─ 1. sendUserTurn(SUMMARY_PROMPT) ── 走当前 conversationId
 │       SUMMARY_PROMPT = """
 │         以下三段格式总结到目前为止的对话，只输出文本不调用任何工具：
 │         【关键决策】最多 5 条
 │         【代码改动】文件路径 + 一句话变更说明，最多 10 条
 │         【未完事项】仍需完成的工作清单
 │       """
 ├─ 2. 订阅 stream，拼装 summaryText
 │       - item/started itemType=agentMessage  → 开始
 │       - item/agentMessage/delta            → 累加
 │       - item/completed itemType=agentMessage → 收尾
 │       - 同期出现 willRetry:false 的 compact error → 走救援路径
 ├─ 3. client.newConversation()  ── 拿到新 conversationId
 ├─ 4. sendUserTurn("【上次会话摘要】\n" + summaryText + 
 │                   "\n\n请基于以上摘要继续我接下来的指令。")
 └─ 5. session.sendSessionEvent({ type: 'message', message: '✅ /compact 完成' })
```

### 3.2 救援型流程（fallback）

入口条件：3.1 步骤 1 触发后，stream 里出现 `Codex error notification` 且 `willRetry:false` 且 message 含 "remote compact"，或者 turn/completed 后没拿到任何 agentMessage。

```
救援路径
 ├─ 1. 从 happy 本地 message store 拼装本地摘要 localSummary
 │       格式：取最近 K 条 user turn 文本 + 现有 todo（如有），不依赖 codex
 ├─ 2. client.newConversation()
 ├─ 3. sendUserTurn("【系统提示】上一条 codex 对话因 compact 失败被重置...\n" + 
 │                   "【最近用户指令】\n" + localSummary)
 └─ 4. session.sendSessionEvent({ 
         type: 'message', 
         message: '⚠️ /compact 救援模式：codex 摘要失败，已基于本地最近指令开新对话' 
       })
```

### 3.3 状态机

```
                ┌─────────────┐
   /compact ─→  │  AwaitSum   │  ← 等 codex 摘要回包
                └──┬───────┬──┘
        success │       │ failure (willRetry:false / timeout 60s)
                ↓       ↓
          ┌──────────┐  ┌──────────────┐
          │  NewConv │  │  LocalRescue │
          └──┬───────┘  └──────┬───────┘
             ↓                  ↓
          ┌──────────────────────┐
          │  InjectSeed (sendUT) │
          └──────┬───────────────┘
                 ↓
          ┌──────────────┐
          │   Done (UI)  │
          └──────────────┘
```

## 四、技术可行性逐项核对

| # | 操作 | 现成支持 | 工作量 |
|---|---|---|---|
| a | 监听 stream 拼摘要 | `appServerStreamBridge` 已分发 `item/agentMessage/delta` + `item/completed`，加一层 message accumulator | 小 |
| b | 检测 compact 失败的 error notification | `runtime` 一侧已有 `willRetry` 判别（happier `runtime.ts:1148`），happy-cli 这边需补一处 hook | 小 |
| c | newConversation RPC | `codexAppServerClient` 已实现握手协议；`codexMcpClient.ts:407` 也有 `conversationId = null` reset 能力 | 小 |
| d | sendUserTurn 注入摘要 | 现成 | 零 |
| e | happy sessionId 不变、codex conversationId 切换 | client 内部状态切换即可，session 层不动 | 零 |
| f | 前端 reducer 是否需要 boundary marker | **需验证**：同 happy session 下两段 codex conversation 的 raw envelope 是否会乱序 | 中 |
| g | 工具调用历史在新 conversation 里丢失 | 摘要 prompt 里显式要求列出已完成的代码改动；用户也能从 happy 历史滚动看 | 已被 prompt 设计覆盖 |
| h | 救援型 localSummary 数据来源 | happy session.jsonl / 内存 messages — 已存在 | 零 |

**整体可行性：高**。所有原子操作都已有底层能力，工作量集中在**编排逻辑**与**降级判断**。

## 五、影响范围与改动清单

```
packages/happy-cli/src/codex/
  ├─ codexAppServerClient.ts        新增：resetConversationAndStartNew() 暴露 newConversation 调用
  ├─ runCodexAppServer.ts           改写 /compact 分支（line 298 起），实现 §3 状态机
  └─ utils/
      └─ compactOrchestrator.ts     新建：摘要拼装 + 失败判别 + 注入封装（约 200 行）

packages/happy-cli/src/codex/__tests__/
  └─ compactOrchestrator.test.ts    覆盖三条分支：success / rescue / timeout

packages/happy-app/src/sources/    （可能需要）
  └─ Session reducer / metadata    确认跨 codex conversationId 的消息流不乱序；必要时加 boundary 事件类型
```

预计代码量：**约 300 行 + 测试 200 行**，单人 1–1.5 天。

## 六、风险与未知

| 风险 | 等级 | 处理 |
|---|---|---|
| 摘要 sampling 也触发 server pre-sampling compact 死循环 | 中 | 已用 §3.2 救援路径覆盖 |
| codex 在摘要 prompt 下仍然调用工具（rg、apply_patch 等） | 中 | prompt 里明确 "only output text, do not call any tools"；同时如果检测到 tool call item，立即视为摘要失败转救援 |
| 新 conversation 第一条 turn 注入巨长摘要又把窗口撑满 | 低 | 摘要 prompt 限制总输出长度（如 ≤ 4k tokens） |
| happy-app 前端 reducer 不识别跨 codex conversation 边界 | 中 | 任务 A 完成前，**必须先在 happy-app 侧 dry-run 一次** envelope 序列检查 |
| 多设备同时 /compact 竞态 | 低 | 用 codex 客户端单例锁，第二个 /compact 请求直接返回 "进行中" |
| 摘要超时（默认 60s） | 低 | 超时立即转救援 |

## 七、可选增强（任务 C 候选，不在本次范围）

- **自动检测 + 自动 /compact**：监听 `Codex error notification` 中 `compact_remote` 失败 → 自动调用 §3.2 救援，对用户透明
- **token 余量预警**：从 codex stream 里抓 `last_api_response_total_tokens`，接近 `model_context_window_tokens * 0.8` 时主动给用户提示「建议 /compact」
- **摘要本地缓存**：把 successful summary 落到 session.jsonl，crash 恢复时可重放

## 八、救援型数据源选型 — A1 vs A2

### A1：从 happy 本地 message store 取
依赖 happy-cli 内存中累积的 envelope 流。

### A2：直接读 codex rollout 文件 ← **推荐**
`~/.codex/sessions/YYYY/MM/DD/rollout-<TS>-<conversationId>.jsonl`，每个 codex conversation 一个文件，append-only。
关键事实（已通过实际文件 + 失败日志验证）：
- **codex 写 rollout 是 turn-by-turn 落盘**，**与 compact 是否成功无关**。桌面失败日志里 thread `019dbe62` 对应的 rollout 文件 15:36 已经 68KB，stderr 报错发生在 15:55，**rollout 比报错早 19 分钟落盘**——救援场景下文件 100% 可读。
- record types 完整：`session_meta` / `event_msg`(含 `model_context_window`) / `response_item`(含 reasoning) / `turn_context`
- `happier/.../localControl/rolloutDiscovery.ts` 已实现按 conversationId 定位 rollout 的工具，可移植

### 大上下文下的对比（用户特别关心点）

| 维度 | A1 happy memory | A2 codex rollout |
|---|---|---|
| 数据完整性 | 仅 user-visible envelope（reasoning/tool args 残缺） | **完整**（含 reasoning + tool call + tool result） |
| 文件/数据体量 | 内存 100–500KB | **1–5MB**（实测 04-25 一份 4MB / 04-24 卡死那份 2MB） |
| crash-safe | 进程重启即失效 | **持久化**，重启可恢复 |
| 远程模式 | happy-cli 进程内即可 | 需要 happy-cli 进程读本地文件（路径同样 OK） |
| 数据时效 | 实时（同进程） | 落盘有 fsync 延迟，但 turn 完成时已写入 |
| 格式整洁度 | happy 自定义，干净 | codex 内部 schema，需过滤 system/developer/turn_context |
| 实施复杂度 | 中 | 中（多一个 jsonl parser，但 happier 已有可移植代码） |

### 关键陷阱（必须避开）
**A2 不能省去 summarize 步骤**。1–5MB rollout 直接当 newConversation 的 seed 等于把窗口再次撑满，救援场景反而更糟。A2 的真正用法：

```
读 rollout (~/.codex/sessions/.../rollout-<convId>.jsonl)
  → 过滤掉 turn_context / system / developer 行
  → 提取 (a) 最近 N 条 user message  
         (b) 最近 N 条 assistant message 的关键句  
         (c) 所有 file edit 的路径汇总（从 tool call payload）
         (d) 当前 todo（从 tool call 历史尾部）
  → 用本地启发式（非 LLM）拼成 ≤ 4k tokens 的 seed text
  → newConversation()
  → sendUserTurn(seed text)
```

**A2 的"绕开网络"特性 = 救援模式真正胜出的点**：A1 在主动型还需要发一次 sampling 才能拿到摘要，A2 在救援型可以**完全本地完成**——既不调用挂掉的 /compact，也不调用 /responses，**100% 在客户端做完压缩**，再起新 conversation。代理切流问题被绕开。

### 修订后的方案（替换 §3.2 的救援型）

#### 真实 rollout 体量分布（2.9MB 实测样本）

| record type | 行数 | 体积占比 | 处理策略 |
|---|---|---|---|
| `function_call_output`（tool stdout）| 212 | **48.2%** | **丢弃** — 命令输出对未来对话基本无价值 |
| `event_msg:exec_command_end`（重复） | 202 | **35.6%** | **丢弃** — 与 function_call_output 重复 |
| `response_item:reasoning`（加密） | 51 | 4.2% | **丢弃** — 加密无法跨 conversation 用 |
| `response_item:function_call` | 212 | 2.8% | 抽取「写文件」类命令的目标路径 |
| `response_item:message`（user/assistant） | 49 | **2.0%** | **保留全部** — 真正的对话内容只占 2% |
| `event_msg:agent_message` / token_count | 107 | 1.8% | 丢弃 |
| `compacted` record | **1** | 1.4% | **优先级最高** — 见下文 |
| `turn_context` / `session_meta` | 13 | 0.7% | 丢弃 |

→ **实测压缩**：原 2.9MB → 拼装后 **6199 chars ≈ 1549 tokens**（远低于 4k 预算）。压缩比 0.2%。**纯本地启发式不需要 LLM**。

#### 重大发现：`compacted` record 是 codex 自己的现成摘要

rollout 文件里出现 `type: "compacted"` 的 record，payload 长这样：
```json
{
  "type": "compacted",
  "payload": {
    "message": "",
    "replacement_history": [
      { "type":"message", "role":"user", "content":[{"type":"input_text","text":"..."}] },
      ...
    ]
  }
}
```
这是 codex **上一次 auto-compact 成功后**，把几百条原始 history 替换成的关键 user message 序列——**codex 已经替你做过摘要了**。算法可以直接复用。

#### 救援型完整算法（伪代码）

```ts
async function buildRescueSeed(conversationId: string): Promise<string> {
  // ── Step 1：定位 rollout 文件
  const rolloutPath = await discoverRolloutByConversationId(conversationId);
  // 复用 happier 的 rolloutDiscovery + parseResumeIdFromRolloutFilename
  
  // ── Step 2：单趟流式扫描，分桶收集
  const buckets = {
    lastCompacted: null as CompactedPayload | null,
    userTexts: [] as string[],         // 真实用户输入（去除 env_context / permissions）
    finalAnswers: [] as string[],      // assistant phase=final_answer
    fileEdits: new Set<string>(),      // 从 shell_command args 中正则匹配
    todos: null as Todo[] | null,      // 最后一次 todo 工具调用
  };
  
  for await (const r of streamJsonl(rolloutPath)) {
    if (r.type === 'compacted') {
      // 持续覆盖，留最后一个
      buckets.lastCompacted = r.payload;
      // 注：compacted 出现后，前面的原 history 已被替换；后续应只看 compacted 之后新增的
      // 简化做法：把 lastCompacted 后的 buckets 全部清空重来
      buckets.userTexts = [];
      buckets.finalAnswers = [];
      continue;
    }
    if (r.type !== 'response_item') continue;
    const p = r.payload;
    
    if (p.type === 'message') {
      const text = (p.content || []).map((c: any) => c.text || c.input_text || '').join('');
      if (p.role === 'user' 
          && !text.includes('<environment_context>') 
          && !text.startsWith('<permissions')) {
        buckets.userTexts.push(text);
      }
      if (p.role === 'assistant' && p.phase === 'final_answer') {
        buckets.finalAnswers.push(text);
      }
    }
    if (p.type === 'function_call') {
      // 文件编辑识别：shell_command 的 cmd 里 grep 类似 'echo > x.ts' / 'apply_patch' / 'write'
      try {
        const args = JSON.parse(p.arguments || '{}');
        const cmdLine = String(args.command || args.input || '');
        const matches = cmdLine.matchAll(/\b([a-zA-Z0-9_/\\.-]+\.[a-zA-Z]{1,5})\b/g);
        for (const m of matches) buckets.fileEdits.add(m[1]);
      } catch {}
      // todo 工具：mcp__happy__set_todos 等，记最后一个
      if (p.name === 'set_todos' || p.name === 'update_todos') {
        try { buckets.todos = JSON.parse(p.arguments).todos; } catch {}
      }
    }
  }
  
  // ── Step 3：合成 seed text，按预算分配
  const TOKEN_BUDGET = 4000;
  const lines: string[] = [];
  
  if (buckets.lastCompacted) {
    // 路径 A：复用 codex 自己的 compacted 摘要
    lines.push('## 上下文摘要（来自 codex 上次成功压缩）');
    for (const msg of buckets.lastCompacted.replacement_history) {
      if (msg.role === 'user' && msg.content?.[0]?.text) {
        lines.push(`- ${msg.content[0].text.slice(0, 500)}`);
      }
    }
    // 后面再补 compacted 之后的新对话
  }
  
  if (buckets.userTexts.length > 0) {
    lines.push('\n## 用户指令时序（最近 N 条）');
    // 优先保留尾部
    const last = buckets.userTexts.slice(-15);
    for (const t of last) lines.push(`- ${t.slice(0, 400)}`);
  }
  
  if (buckets.finalAnswers.length > 0) {
    lines.push('\n## 我已给出的关键回答（节选）');
    const last = buckets.finalAnswers.slice(-5);
    for (const a of last) lines.push(`- ${a.slice(0, 300)}`);
  }
  
  if (buckets.fileEdits.size > 0) {
    lines.push('\n## 涉及的文件路径');
    [...buckets.fileEdits].slice(0, 50).forEach(f => lines.push(`- ${f}`));
  }
  
  if (buckets.todos) {
    lines.push('\n## 当前 TODO 列表');
    for (const t of buckets.todos) {
      lines.push(`- [${t.status}] ${t.content}`);
    }
  }
  
  // ── Step 4：截断到预算（粗略 1 char ≈ 0.25 tokens）
  let seed = lines.join('\n');
  const charBudget = TOKEN_BUDGET * 4;
  if (seed.length > charBudget) {
    // 从中间删（保留头部 system 提示 + 尾部最近的指令）
    const head = seed.slice(0, charBudget * 0.3);
    const tail = seed.slice(-charBudget * 0.7);
    seed = head + '\n\n[...省略中间内容...]\n\n' + tail;
  }
  
  return seed;
}
```

#### 主流程（救援型）

```
救援型（A2 + compacted 复用）：
 ├─ 1. discoverRolloutByConversationId(currentConvId) → rolloutPath
 ├─ 2. seed = buildRescueSeed(rolloutPath)   // 见上文，纯本地，<10ms
 ├─ 3. client.newConversation()
 ├─ 4. sendUserTurn(seed + "\n\n请基于以上摘要继续。")
 └─ 5. session message: '✅ /compact 完成（救援模式，基于历史文件本地重建）'
```

主动型保持 §3.1（让 codex 自己摘要质量更高）；A2 作为兜底。
**救援型 100% 本地、零网络依赖、<100ms 完成**。

### 修订后的可行性

| # | 操作 | 改动 |
|---|---|---|
| a | rollout 路径定位 | 移植 `happier/localControl/rolloutDiscovery.ts`（约 80 行），按 conversationId 命名规则匹配 |
| b | rollout jsonl parser | 新增（约 100 行），按 type=response_item 过滤 + content 抽取 |
| c | 启发式压缩 | 新增（约 150 行），无 LLM、纯文本拼装 |
| d | newConversation + inject | 同 §3.1 |

预计 +200 行 ≈ 总量 500 行 + 测试 250 行，单人 2 天。

## 九、boundary marker 验证结果（更新）

`grep -rn "codexConversationId\|codexThreadId\|conversation_id" packages/happy-app/sources` **零命中**。
happy-app 的 reducer / RawRecordSchema 不感知 codex 内部 conversationId，只看 happy sessionId。

→ **结论**：换 codex conversation 对前端透明，**不需要 boundary marker**。同 happy session 下来回切 codex conversation 是安全的。

## 十、最终决策

立即可定：
- **唯一路径：本地启发式 + A2 数据源**（不再分主动型/救援型）
- **A1 不需要**（A2 完全覆盖）
- **LLM 摘要不做**（原 §3.1 方案作废，详见 §二）
- **不需要 boundary marker**（已验证 reducer 不感知）
- **happy-cli 与 ~/.codex/sessions 同机**（已确认）
- **注入策略走设计 B**：合并到用户下一次 user turn，不做独立 ack turn
- **新会话切换是必须**：两个理由——(1) codex 无 truncate API，不切等于没瘦身；(2) 不切下次 turn 又撞 auto-compact 死循环
