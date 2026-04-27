# Codex 客户端 /compact 方案 — 当前架构（v2）

> **状态**：已实现并随 v0.13.0-compat.x 发布。本文档反映 commits
> `c42739e0`、`bb1902f9`、`10cffd9f`、`1665078a`、`eaf19aa4`（2026-04-25）落地后的真实架构。
>
> v1 文档（"放弃 LLM 摘要、统一走本地启发式"）的核心结论已被 §11 推翻 —— 引入 fresh `codex exec` 进程后，LLM 路径不再受原会话上下文上限制约。v1 的事实分析（rollout 体量、`compacted` record 复用、reducer 不感知 conversationId 等）仍然成立，被并入本文相应章节。

---

## 一、问题背景与目标语义

### 1.1 两层根因

1. **协议缺口**：codex app-server 协议没有 manual-compact RPC，也没有 per-session context-clear RPC。`/compact`、`/clear` 字面发出去就是普通 user prompt，LLM 顶多回一句"好的我知道了"，**静默失败**。
2. **服务端不稳定**：codex 自带的 auto pre-sampling compact 走 `https://chatgpt.com/backend-api/codex/responses/compact`（约 800 KB / 次），经过本机代理时偶发 stream 切断（`Proxy CONNECT response missing status line`），实测失败率约 **25%**；codex 自身 `willRetry: false`，turn 直接终止，UI 只剩 `Codex error: stream disconnected`。

### 1.2 对用户可见的承诺

| 承诺 | 实现位置 |
|---|---|
| happy session 不变（前端 sessionId 不动，历史不裂） | reducer 不感知 codex conversationId（§12 验证） |
| 当前 codex conversation 被丢弃，新 conversation 的种子是压缩后文本 | `runCodexAppServer.ts:567-573` reset threadId + 暂存 seed |
| 永不静默失败：成功/降级都给明确状态信息 | `Compaction started` / `Compaction completed` / visible summary（§10） |
| 服务端 auto compact 挂掉时自动接管，体验等同手动 /compact | auto-rescue 复用同一条 `runManualCompact` 路径（§8） |

---

## 二、整体架构

```
                ┌───────────────────────────────────────────┐
                │  入口（统一路径 runManualCompact）         │
                ├───────────────────────────────────────────┤
   /compact ───▶│  · 手动：parseSpecialCommand 拦截         │
                │  · 自动：error notification → auto-rescue │
                └───────────────────────┬───────────────────┘
                                        │
            ┌───────────────────────────▼─────────────────────────┐
            │  L1 启发式 (compactSeedBuilder.buildHeuristicSeed)   │
            │  · 读 rollout jsonl（rolloutDiscovery 定位）         │
            │  · 分桶 + 动态预算 → ≤12 K tokens 的 heuristicSeed   │
            │  · 首行 SEED_SENTINEL 哨兵（§7 反内卷）              │
            │  · ~22ms（5.75MB rollout 实测）                      │
            └───────────────────────────┬─────────────────────────┘
                                        │
            ┌───────────────────────────▼─────────────────────────┐
            │  L2 LLM 摘要 (compactViaCodexExec)                   │
            │  · spawn 全新 `codex exec` 进程（独立 context window）│
            │  · gpt-5.4-mini, reasoning=none, web_search=disabled │
            │  · 输入 = L1 seedText                                │
            │  · 三种结果：summary / short_circuit / fail          │
            │  · 任何失败都透明回退到 L1（永不抛错）                │
            └───────────────────────────┬─────────────────────────┘
                                        │
            ┌───────────────────────────▼─────────────────────────┐
            │  注入策略                                             │
            │  · seedText = wrapL2SeedAsHeuristicSeed(summary)      │
            │    （仍带 SEED_SENTINEL，保证下次 /compact 还能识别）  │
            │  · threadId = null + compactState.pendingSeedText     │
            │  · 协议事件：Compaction started → visible summary →   │
            │    Compaction completed                              │
            │  · 下一条 user 消息触发 turn loop → newConversation → │
            │    seed prepend 到首 turn                             │
            └─────────────────────────────────────────────────────┘
```

**两层结构的设计抓手**：
- L1 把任意大小的 rollout 压到 ≤12 K token 的稳定上界，**保证 L2 输入永远不会撑爆 fresh exec 的 context window**
- L2 把 L1 的"机械分桶 bullet"升级成"叙事性摘要"，质量对齐 Claude Code `/compact`
- 任何一层失败都不杀 user 流：L2 失败回退 L1，L1 失败给状态消息

---

## 三、核心模块清单

| 模块 | 路径 | 职责 |
|---|---|---|
| `runCodexAppServer.ts` | `packages/happy-cli/src/codex/` | 拦截 `/compact`、`/clear`；编排 runManualCompact；监听 error notification 触发 auto-rescue；管理 `compactInFlight` / `compactState.pendingSeedText` |
| `utils/rolloutDiscovery.ts` | 同上 | 按 conversationId 在 `$CODEX_HOME/sessions` 下从新到旧定位 rollout jsonl |
| `utils/compactSeedBuilder.ts` | 同上 | L1 启发式：流式扫 rollout、分桶、动态预算、SEED_SENTINEL 检测、smartTruncate |
| `utils/codexExecCompact.ts` | 同上 | L2 fresh-exec：spawn `codex exec`、提示词构造、三结果分支、`renderCompactionResultMessage`、`wrapL2SeedAsHeuristicSeed` |
| `utils/codexAutoRescue.ts` | 同上 | `shouldAutoRescue` 错误签名匹配 + `createRescueGate` 冷却闸门 |
| `utils/turnLifecycle.ts` | 同上 | turn 状态机；`finish()` 单出口，保证任一终态信号都能 settle awaiter |
| `codexAppServerClient.ts` | 同上 | `buildWindowsSpawnArgs` 已 export，L2 复用其 cmd.exe shim 处理（Windows SSoT） |

测试覆盖：`compactSeedBuilder.test.ts`（574 行）、`codexExecCompact.test.ts`（278 行，含 `HAPPY_TEST_REAL_CODEX=1` 的 opt-in 集成测试）、`rolloutDiscovery.test.ts`、`turnLifecycle.test.ts`、`codexAutoRescue.test.ts`。

---

## 四、L1：启发式种子构建（compactSeedBuilder.ts）

### 4.1 数据源与扫描算法

输入：rollout jsonl 文件路径（由 `rolloutDiscovery.findRolloutByConversationId` 给出）。

单趟流式扫描，按 record 类型分桶：

```
buckets = {
  lastCompacted:  CompactedPayload | null,    // codex 自己的现成摘要
  userTexts:      string[],                    // role=user 的真实输入
  finalAnswers:   string[],                    // role=assistant phase=final_answer
  fileEdits:      Set<string>,                 // 从 function_call args 抽取的文件路径
  todos:          Todo[] | null,               // 最后一次 set_todos / update_todos
}
```

噪声过滤：`isNoiseUserMessage` 丢弃 `<environment_context>`、`<permissions ...>` 等 wrapper 注入。
敏感信息：`SENSITIVE_PATTERNS` + `redactSensitive` 过滤 access_token / api_key 等。

### 4.2 复用 codex 自己的 `compacted` record

rollout 里出现 `type: "compacted"` 时，codex 已经把几百条 history 替换成了精炼的 `replacement_history`。L1 直接把它扔进 `lastCompacted` 桶，并**清空 `userTexts` / `finalAnswers`**（因为 compacted 之后这两个桶里的旧条目都已经被 codex 自己合并过了，再保留就是重复）。

### 4.3 SEED_SENTINEL 检测（详见 §7）

`processResponseItem` 在 `text.startsWith(SEED_SENTINEL)` 时，把整条 user message 当作"上一次 /compact 注入的 seed"处理：合成一个 `lastCompacted` 替代品，把已有的 `userTexts` / `finalAnswers` 清空。这是防止 seed 在多次 /compact 中无界增长的核心机制。

### 4.4 桶预算与组合

```ts
const TOKEN_CHAR_RATIO = 4;                    // 粗估 1 token ≈ 4 chars
const DEFAULT_TOKEN_BUDGET = 12_000;           // ~4.7% of 256k context window
const MAX_FILE_PATHS = 50;
const USER_RECENT_FORCE_KEEP = 3;              // 最近 3 条 user message 必保留
const MIN_TRUNCATE_CHARS = 120;
```

`estimateBucketWants` → `allocateBucketBudgets` 按 `BUCKET_RATIOS` 动态分配预算。`composeSeed` 把 SEED_SENTINEL 当作首行写出，再按桶顺序填内容，最后追加 `trailerNote`（默认/调用方提供）。

`packBucket` 在单桶溢出时调用 `smartTruncate`：保留代码块、表格、关键字（"决策"、"修复"、"TODO" 等）行，舍弃空段。无法智能切的单段文本走 `headTailTruncate`（head 40% + tail 60% + 省略标记）。

### 4.5 输出契约

```ts
interface BuildSeedResult {
    seedText: string;            // 必带 SEED_SENTINEL 首行
    stats: {
        userTurns, finalAnswers, fileEdits: number;
        hadCompactedRecord: boolean;
        approximateTokens: number;
        bucketUsage: { compacted, user, assistant, files, todos: number };
    };
}
```

实测：5.75 MB rollout → ~22 ms → 12 K tokens 上界。

---

## 五、L2：LLM fresh-exec 摘要（codexExecCompact.ts）

### 5.1 为什么是 "fresh process" 而不是 "ask the live thread"

| 路径 | 致命问题 |
|---|---|
| 在原 conversation 发摘要 prompt | history 已高位 → pre-sampling compact 必触发 → 撞同一个 25% 失败率的接口 |
| 先 `newConversation` 再让它摘要 | 新会话空 history，没东西可摘要 |
| **spawn 一个新进程 `codex exec` 喂 L1 seed** ✅ | **新进程自带干净 context window，L1 seed ≤12 K 永远塞得下** |

v1 文档放弃 LLM 摘要的根本原因是**没区分"在线问 codex"和"开新进程问 codex"**。fresh process 路径解开了死结。

### 5.2 spawn 参数（每个都踩过坑）

```ts
codex exec --output-last-message <tmpfile> \
           -m gpt-5.4-mini \
           -c model_reasoning_effort="none" \
           -c web_search="disabled" \
           <prompt-from-stdin>
```

| 参数 | 选型理由 |
|---|---|
| `gpt-5.4-mini` | 摘要任务不需要旗舰模型；同时 mini 拒绝 `reasoning_effort="minimal"`，必须用 `none` |
| `model_reasoning_effort="none"` | 摘要不需要 chain-of-thought；省 token、省 latency |
| `web_search="disabled"` | API 规则：`effort=none` 时**必须**显式禁用 web_search，否则报错 |
| `-c web_search="disabled"` 而非 `--disable web_search` | codex CLI quirk，flag 形式不生效，只能用 `-c` 形式 |
| `--output-last-message <tmpfile>` | 把 LLM 输出写到独立文件读取，避免与 codex CLI 自身的 stderr / progress 混杂 |
| Windows：经 `buildWindowsSpawnArgs` 包 `cmd.exe /d /s /c "..."` | TOML 引号 `web_search="disabled"` 必须经 cross-spawn 算法转义 |

### 5.3 关键常量

```ts
const DEFAULT_TIMEOUT_MS    = 120_000;   // 覆盖 codex CLI 自带 5 次重试的最坏情况
const DEFAULT_MODEL         = 'gpt-5.4-mini';
const DEFAULT_EFFORT        = 'none';
const MIN_SEED_CHARS_FOR_LLM = 1500;     // 短于此 short_circuit，不付 L2 固定 token 成本
const MIN_OUTPUT_CHARS      = 100;       // 输出短于此视为 fail，避免空气泡
```

### 5.4 三种结果与回退契约

```ts
interface CodexExecCompactResult {
    summary: string | null;
    elapsedMs: number;
    skipped?: 'short_circuit';
    error?: string;       // 任何失败都装这里，不抛异常
}
```

| 路径 | 触发条件 | seedText 取值 |
|---|---|---|
| **L2 success** | `summary !== null` 且 `length >= MIN_OUTPUT_CHARS` | `wrapL2SeedAsHeuristicSeed(summary, trailerNote)` |
| **short_circuit** | `seed.length < MIN_SEED_CHARS_FOR_LLM`，<50ms 直接返回 | 保留 L1 heuristicSeed 不变 |
| **L2 fail** | timeout / 网络 / auth / 缺失 binary / 输出过短 | 保留 L1 heuristicSeed，记 debug log，永不抛 |

**`wrapL2SeedAsHeuristicSeed` 的关键作用**：把 L2 的纯叙事文本重新包成"看起来像 L1 输出"的格式（首行 SEED_SENTINEL + 标题 + 内容 + trailer），保证下一次 /compact 读到这条注入时，L1 的哨兵检测仍然生效（§7）。

### 5.5 性能与成本（实测 2026-04-25，5.75 MB rollout）

| 指标 | 数值 |
|---|---|
| L1 阶段 | ~22 ms |
| L2 稳定网络 | 12-25 s |
| L2 差网络（CLI 内部 5 次重试） | 60-120 s |
| L2 单次 token 消耗 | ~15 K（L1 seed + codex baseline） |
| L2 输出体量 | ~3 KB 叙事摘要（vs L1 的 bullet 列表显著更易读） |

### 5.6 信息泄漏防御

`renderCompactionResultMessage` 对失败路径**只渲染人类可读状态**（"对话较短"/"LLM 摘要不可用"），**不暴露 stderr / 路径 / exit code**——单元测试 (`codexExecCompact.test.ts:does not leak internal error details`) 显式锁这个契约。

---

## 六、SEED_SENTINEL 反内卷机制（10cffd9f）

### 6.1 问题：未加哨兵之前的内卷链

```
第 1 次 /compact：
  rollout(7K) → seed(7K) → 注入新 thread 首 turn

  codex 把这条 user message 持久化进新 thread 的 rollout
  → 新 rollout 里有一条 "role:user, text=<seed 7K>" 的 response_item

第 2 次 /compact：
  新 rollout(已含 7K seed 作为普通 user 消息) + 真实新对话
  → L1 把那条 7K seed 当成"超长用户输入"塞进 user bucket
  → seed = 7K (旧) + 7K (新) = 14K

第 3 次 /compact：
  → 21K → 触发 GLOBAL_CHAR_CAP (48K) → head/tail 截断真实用户历史 ❌
```

### 6.2 修复：哨兵 + 检测

```ts
export const SEED_SENTINEL = '<!--HAPPY-COMPACT-SEED-v1-->';
```

- **写端**（`composeSeed`）：每次 `buildHeuristicSeed` 输出的 seedText **首行就是 SEED_SENTINEL**。HTML 注释格式天然不会被 markdown 渲染干扰，对 LLM 也是自然语言里的"段落标识"。
- **读端**（`processResponseItem`）：检测到 user message 以 SEED_SENTINEL 开头时，**不**塞进 `userTexts` 桶，而是合成一个 `lastCompacted` 替代品，复用既有的"compacted record 优先级最高 + 清空旧 user/assistant 桶"逻辑。
- **包装端**（`wrapL2SeedAsHeuristicSeed`）：L2 的叙事摘要被重新包装时也带上哨兵，保证 L2 路径不绕过反内卷。

### 6.3 验证

`compactSeedBuilder.test.ts` 三个专项测试：
1. `emits SEED_SENTINEL as the first line of every produced seed`
2. `routes user message starting with SEED_SENTINEL to compacted bucket`
3. `clears prior user/assistant buckets the same way processCompacted does`

实测 rollout `019dc4b9-...jsonl`：修复前 seed 7209 → 13693 chars 单调增长；修复后稳定在 ~12 K。

---

## 七、auto-rescue 闭环（codexAutoRescue.ts + bb1902f9）

### 7.1 触发签名

```ts
function shouldAutoRescue(params: unknown): boolean {
    const detail = extractCodexErrorDetail(params);
    if (detail?.willRetry !== false) return false;
    return detail.message?.includes('Error running remote compact task') ?? false;
}
```

`willRetry: false` 排除 codex 自己还会重试的瞬时错误，**只接管 codex 已经放弃的终态错误**。needle 字符串精确锁住 server-side compact 失败签名。

### 7.2 冷却闸门 release/rollback

```ts
const autoRescueGate = createRescueGate(30_000);

// 失败到达时
if (shouldAutoRescue(params) && autoRescueGate.tryClaim(Date.now())) {
    void runManualCompact('compact', /* autoTriggered */ true).catch((err) => {
        autoRescueGate.release();   // ← 关键：rescue 自身失败时回滚 claim
        // ...
    });
}
```

| 设计点 | 理由 |
|---|---|
| 30 s 冷却 | codex 自家失败风暴常见 5 次/2 s，避免重复 spawn rescue |
| `release()` 回滚 | rescue 跑挂了不能锁死窗口，否则用户后续真失败也救不了 |
| 不计数，单 token | 同一窗口里只允许一个 in-flight rescue，简化心智模型 |

### 7.3 与手动 /compact 的统一路径

`runManualCompact(mode, autoTriggered)` 是唯一入口。`autoTriggered` 仅影响：
1. **状态条 label**：`'/compact'` ↔ `'本地压缩'`（不暴露 "auto-rescue" 内部抽象）
2. **可见摘要**：`autoTriggered=true` 时不发送 visible summary（避免 mid-conversation 突然出现一段长摘要打断用户思路）

其他所有逻辑（L1 / L2 / 哨兵 / threadId reset / 协议事件 / pendingSeedText 注入）完全共享代码路径——auto-rescue 在用户视角与手动 /compact 100% 等效。

---

## 八、状态机与并发守卫

### 8.1 compactInFlight：互斥

```ts
let compactInFlight = false;
```

- `runManualCompact` 入口若 `compactInFlight === true` → 立即返回 `⚠️ {opLabel} 进行中`
- 拦截器 `runCodexAppServer.ts:316-319` 在用户 turn 到达时也检查：若 compact 正在 rollout-read 与 threadId swap 之间，**拒绝新 user 消息**，避免 swap-race 把消息发到旧 thread

### 8.2 turnLifecycle：单出口不变式

`runManualCompact` 在做 rollout 读取前 `await turnLifecycle.current?.catch(() => {})`，等当前 turn settle 再切 thread——避免打断 in-flight stream 丢失部分输出。

`turnLifecycle.finish()` 是 turn 状态机**唯一出口**，被四种终态信号路由到：
- `turn/completed`
- `turn/interrupted`
- `error` notification
- 顶层 RPC failure（catch 路径）

任一信号都能 settle awaiter，因此 `await turnLifecycle.current` 可以**不设超时**——状态机本身保证不挂。

### 8.3 Stale notification guard

`runCodexAppServer.ts:867-890` 在 `turn/completed` 处理时校验 `notifTurnId === activeTurnId`：/compact swap 或 auto-rescue 重切 thread 后，旧 thread 延迟到达的 `turn/completed` 不会污染新 turn 的 lifecycle promise（bridge 仍收到通知做协议簿记，仅 lifecycle 层面忽略）。

---

## 九、用户可见 UX 协议

### 9.1 协议事件序列（手动 /compact）

```
session events:
  → message: "Compaction started"           ← happy-app 与 Claude 一致的协议字符串
  → message: <visible summary>              ← L2 success: 叙事摘要（~1.5 KB）
                                              short_circuit: "已使用本地启发式摘要（对话较短）"
                                              L2 fail:       "已使用本地启发式摘要（LLM 摘要不可用）"
  → message: "Compaction completed"         ← reducer 匹配此精确字符串 → contextSize 归零
  → ready
```

`/clear` 路径：`Compaction started` 改为不发，结束 ack 是 `"Context was reset"`（reducer 同样归零 contextSize），不构建 seed，threadId 直接置 null。

### 9.2 auto-rescue 静默策略（eaf19aa4）

`autoTriggered === true` 路径：
- **跳过** visible summary（`if (!autoTriggered)` 门）
- 状态条 label 用 `"本地压缩"`（手动 /compact 用 `"/compact"`）
- 仍发 `Compaction started` / `Compaction completed`，因此 contextSize 仍正确归零

理由：auto-rescue 在用户对话流中间触发，丢一段几百字摘要进去比"什么都没说但帮我修好了"更打断。

### 9.3 与 Claude Code 的对齐

happy-app 的 `/compact` 体验与 Claude Code SDK（`claudeRemote.ts:241-247`）对齐：把摘要作为 assistant 消息流式渲染在 `Compaction started` / `Compaction completed` 中间。L2 路径让 codex 也获得了等价 UX。

---

## 十、注入策略：pendingSeedText

```
runManualCompact 末尾：
  threadId = null
  threadIdStored = false
  opts.codexSessionId = undefined
  compactState.pendingSeedText = seedText      ← 关键：seed 暂存
  emit "Compaction completed"

下条用户消息到达 → turn loop 顶端 if (!threadId) → thread/start → newConversation
turn/start 准备发送时 (runCodexAppServer.ts:1289)：
  const seed = compactState.pendingSeedText
  if (seed) { 把 seed prepend 到本次 user message 前；pendingSeedText = null }
```

这套"reset + 暂存 + 下个 turn 注入"的拆解避免了"先开新 conversation 再单独发一个 seed turn"的两次 RPC，把 seed 与用户真实指令合并成一次 `turn/start`，省一次 round-trip 也降低中间态被打断的窗口。

---

## 十一、设计演进史（v1 → v2）

### 11.1 v1 决议（2026-04-25 上午，c42739e0）

> "LLM 摘要在原会话 / 新会话两端都是死路 → 统一走本地启发式（唯一路径）。零网络、零失败点。"

v1 代码已落地：rolloutDiscovery + compactSeedBuilder（L1）+ runManualCompact 主链路 + auto-rescue 复用（bb1902f9）。

### 11.2 v1 的盲区

v1 把 "LLM 摘要" 等价于 "在线问 codex"。**没考虑过 spawn 一个独立的 `codex exec` 进程**——而 fresh process 自带干净 context window，L1 seed ≤12 K 永远不会触发 pre-sampling compact，绕开了 25% 失败率的接口。

### 11.3 v2 增量（2026-04-25 晚，三连提交）

- **`10cffd9f`** 反内卷哨兵：v1 主链路上线后压测发现 seed 单调增长（7K→14K→20K…），溯源到 codex 把 seed 持久化为普通 user message。引入 `SEED_SENTINEL` + `processResponseItem` 检测把内卷断在第二次 /compact 之前。
- **`1665078a`** L2 引擎：新增 `compactViaCodexExec` + 配套 helper。3 KB 叙事摘要 vs L1 的 bullet 列表，质量对齐 Claude `/compact`。
- **`eaf19aa4`** UX 闭环：把 L2 接到 runManualCompact 主链路，加 visible summary（仅手动），auto-rescue 静默。

### 11.4 保留与作废

| v1 章节 | v2 状态 |
|---|---|
| §一 目标语义 | **保留**（本文 §1.2） |
| §二 放弃 LLM 摘要 | **作废**（详见本节 §11.2） |
| §3.1 主动型 LLM 流程 | **作废** —— 由 L2 fresh-exec 取代 |
| §3.2 救援型本地启发式 | **保留并升级**为 L1（本文 §4） |
| §3.3 状态机 | **重构**（本文 §2 总图 + §8 守卫） |
| §八 救援型数据源选型 A1 vs A2 | **保留结论**：A2 (rollout 文件) 完胜，已实现为 `rolloutDiscovery` |
| §九 boundary marker 验证 | **保留**（本文 §12） |

---

## 十二、boundary marker 验证（保留 v1 §九结论）

`grep -rn "codexConversationId\|codexThreadId\|conversation_id" packages/happy-app/sources` 仍然零命中（2026-04-26 复验）。

happy-app 的 reducer / RawRecordSchema 不感知 codex 内部 conversationId，只看 happy sessionId。**结论**：换 codex conversation 对前端透明，**不需要 boundary marker**。同 happy session 下来回切 codex conversation 是安全的。

`runCodexAppServer.ts` 在 threadId 切换后会通过 `notification` 把新 threadId 同步进 happy session metadata（`threadIdStored = false` 触发 refresh）；happy-app 对此只做 metadata 落盘，不影响 message 流。

---

## 十三、风险与已知限制

| 风险 | 等级 | 处理 |
|---|---|---|
| L2 在差网络下 60-120 s 阻塞 | 中 | codex CLI 自带 5 次重试覆盖了大部分瞬态；显式 cancel UI 暂未做（PR 讨论后延期） |
| L2 spawn 失败（codex binary 不在 PATH） | 低 | 透明回退到 L1，debug log 记录 |
| L2 输出泄漏内部错误细节给用户 | 低 | `renderCompactionResultMessage` 单元测试锁住"不暴露 stderr / 路径 / exit code"契约 |
| 多设备同时 /compact 竞态 | 低 | `compactInFlight` 是单进程内的 mutex；多设备走同一 happy-cli 进程，等价于多个用户消息排队 |
| auto-rescue 在 30s 窗口内只允许一个 | 已知设计 | `release()` 回滚保证 rescue 失败不锁死窗口 |
| /compact 后用户立即发消息撞 swap-race | 已防御 | 拦截器在 `compactInFlight` 时返回 `进行中`，等 swap 完成再放行 |
| 极长单条 user message（>48 KB）撑爆 L1 全局上限 | 低 | `headTailTruncate` 兜底，配 `USER_RECENT_FORCE_KEEP=3` 保证最近输入不被丢 |
| L2 偶发吐出空字符串 | 低 | `MIN_OUTPUT_CHARS=100` + 调用方 `if (l2.summary)` 双重防线 |

---

## 十四、未来增强（候选，非本次范围）

- **token 余量预警**：从 codex stream 抓 `last_api_response_total_tokens / model_context_window_tokens`，>80% 时主动提示用户 /compact（可参考 e75188f5 的 token 监控基础设施）
- **L2 结果落本地缓存**：把 successful summary 与 sourceConversationId 一起落到 `~/.happy` 下的 cache，crash 恢复时重放
- **L2 显式 cancel**：用户在 L2 等待期间发新消息或按取消，杀掉 spawn 的 codex exec 进程，回退到 L1 完成压缩
- **L2 模型可配**：`compactViaCodexExec` 已经接受 `model` / `reasoningEffort` 参数，缺一个 happy-cli 配置文件入口

---

## 附录：关键常量速查

```ts
// compactSeedBuilder.ts
SEED_SENTINEL              = '<!--HAPPY-COMPACT-SEED-v1-->'
TOKEN_CHAR_RATIO           = 4
DEFAULT_TOKEN_BUDGET       = 12_000           // tokens
MAX_FILE_PATHS             = 50
USER_RECENT_FORCE_KEEP     = 3
MIN_TRUNCATE_CHARS         = 120

// codexExecCompact.ts
DEFAULT_TIMEOUT_MS         = 120_000
DEFAULT_MODEL              = 'gpt-5.4-mini'
DEFAULT_EFFORT             = 'none'
MIN_SEED_CHARS_FOR_LLM     = 1500
MIN_OUTPUT_CHARS           = 100

// runCodexAppServer.ts
autoRescueGate cooldown    = 30_000 ms
auto-rescue signature      = willRetry===false && msg.includes('Error running remote compact task')
```
