# codex Fallback 压缩 · 项目级 `.happy` 固定文档注入（设计方案 v2.1）

> 状态：设计定稿，待实现
> 适用后端：`HAPPY_CODEX_BACKEND_MODE=appServer`（`src/codex/runCodexAppServer.ts`）
> 评审：经 3 轮 plan-review 收敛至 43/50（⭐⭐⭐⭐ 优秀，无 P0/P1）

---

## 1. 背景与动机

codex 的 fallback 压缩（`/compact` 手动触发，或上下文溢出时的 auto-rescue）会把整段对话历史压成一个 seed：

```
buildHeuristicSeed（本地启发式）→ compactViaCodexExec（L2 LLM 叙事摘要）→ seedText → 注入下一轮新 thread
```

压缩固然回收了上下文，但也**丢失了项目级的长青信息**——架构总览、团队约定、长期目标、那些"每次都要让模型重新知道"的背景。用户当前的唯一补救是压缩后手动把这些再讲一遍。

本特性提供一个**项目级常驻锚点**：在项目里放一个固定文档，每次 fallback 压缩时自动把它的内容附到压缩结果尾部，随 seed 一起注入新 thread。压缩永远不会冲掉它。

与 codex `AGENTS.md` / Claude Code `CLAUDE.md` 的区别：那些是**每一轮**都注入 system 层的项目记忆；本特性**仅在 fallback 压缩时**注入到 seed 尾部，专门解决"压缩后失忆"，平时零开销。

---

## 2. 特性总览

| 维度 | 说明 |
|---|---|
| 文档位置 | `<项目根>/.happy/on-fallback-compact.md` |
| 项目根 | `process.cwd()`（codex 会话工作目录，仅此一处，不向上查找） |
| 触发时机 | **仅** fallback 压缩：手动 `/compact` + auto-rescue；`/clear` 与平时对话不读 |
| 注入位置 | seed 末尾，独立成对哨兵包裹 |
| 刷新 | 每次压缩从磁盘重读 → 改文档即时生效 |
| 配置 | 无需开关；文件存在即启用，不存在即静默跳过。上限可选 `HAPPY_FALLBACK_DOCS_MAX_CHARS` 覆盖 |
| 安全 | 高置信密钥模式脱敏兜底 |

---

## 3. 用户视角：如何使用

1. 在项目根目录建立 `.happy/on-fallback-compact.md`。
2. 写入希望"压缩永不丢失"的项目背景，例如：
   - 项目架构 / 模块边界 / 关键目录
   - 团队约定（命名、提交规范、技术选型理由）
   - 长期目标、当前里程碑、不可回退的决策
   - 任何"每次压缩后都得重新交代"的上下文
3. 之后无需任何操作。每次 codex 触发 fallback 压缩（手动 `/compact` 或上下文溢出自动压缩）时，该文档会被自动读取、附到压缩摘要后面，注入到新对话里。
4. 随时修改该文档，下一次压缩立即采用最新内容。

**建议**：

- 控制在 ~16K 字符（≈4K tokens）以内。超出会按行边界截断、仅保留头部并加警告。
- 它是常驻"锚点"，不是知识库——放最关键的纲领性信息，不要堆细节。
- 不要放真实密钥（虽然有高置信脱敏兜底，但不应依赖它）。

---

## 4. 已锁定的设计决策

| # | 决策 | 选择 | 理由 |
|---|---|---|---|
| D1 | 项目根定位 | 仅 `process.cwd()` | 简单可预测；与 sandbox writableRoots / turn cwd 同源 |
| D2 | 文档组织 | 单一文件 | 契约清晰，无需遍历/排序 |
| D3 | 文件名 | `on-fallback-compact.md` | 专一、绑定 compact 用途；避免 `context.md` 这类通用名引发"平时也读"的误解 |
| D4 | 注入位置 | seed 末尾 + 独立哨兵 | 整条仍以 `SEED_SENTINEL` 开头，不破坏自循环检测；独立哨兵供下一轮剥离 |
| D5 | 防膨胀 | 下一轮 seed builder 剥离 | 文档每轮从磁盘重注入，不在 rollout 存活，不进 compacted budget |
| D6 | 脱敏 | 高置信模式 | 闭合密钥落盘缺口，且不误伤文档里的 `name=value` 讲解 |
| D7 | 触发范围 | 仅 compact，`/clear` 跳过 | `/clear` 语义是彻底重置 |

---

## 5. 整体数据流（3 个时刻）

```
【时刻 A：本轮 fallback 压缩】runManualCompact()
  buildHeuristicSeed → compactViaCodexExec(L2) → 组合出 seedText
  → seedText += loadFallbackCompactDocs(sessionCwd)     // 读盘 + 脱敏 + 包哨兵
  → compactState.pendingSeedText = seedText

【时刻 B：下一轮 turn/start】
  turnInputText = `${seed}\n\n${用户消息}`              // seed（含 docs）prepend 注入一次后清空

【时刻 C：再次 fallback 压缩】buildHeuristicSeed 扫描新 rollout
  读到时刻 B 注入的 user message（以 SEED_SENTINEL 开头）
  → stripProjectDocs(text) 剥离 docs 块 → 其余进 compacted bucket
  → L2 输入不含旧 docs；末尾再 loadFallbackCompactDocs 重新读盘附加（磁盘最新版）
```

---

## 6. 注入后下一轮 user message 的结构

```
<!--HAPPY-COMPACT-SEED-v1-->          ← SEED_SENTINEL（整条以它开头，startsWith 检测不受影响）
## 上下文摘要（happy /compact …重建）
…摘要 / ### 最近 N 轮完整对话 / trailer…
请基于以上摘要继续。

<!--HAPPY-PROJECT-DOCS-v1-->          ← 项目文档独立哨兵
## 项目固定上下文（来自 .happy/on-fallback-compact.md…）
…on-fallback-compact.md 全文（已 sanitize / 高置信脱敏 / 按需截断）…
<!--/HAPPY-PROJECT-DOCS-v1-->

继续 / <用户真实消息>
```

---

## 7. 防膨胀闭环（时序推演）

| 轮 | seed builder 行为 | docs 去向 |
|---|---|---|
| 第 1 次 compact | — | 末尾读盘附加 docs_v1 → 注入 |
| 第 2 次 compact | 读到含 docs_v1 的 user message → `stripProjectDocs` 剥离 → 干净 payload 进 compacted bucket | L2 看不到旧 docs；末尾再读盘附加 docs（磁盘最新） |
| 第 N 次 | 同上，每轮剥离上轮注入的 docs | compacted bucket 永不含 docs，不占其 `COMPACTED_ABS_CAP_RATIO`（0.30）配额 |

**关键不变量**：项目文档始终走"磁盘 → 注入 → 下轮剥离 → 重新读盘"，永不进入 seed 的预算自循环，因此既不逐轮膨胀，也始终保持磁盘最新。

---

## 8. 文件改动清单（4 个）

### ① 新建 `src/codex/utils/redactSecrets.ts`（叶子模块，SSoT 脱敏）

> 从 `compactSeedBuilder.ts` 抽出脱敏逻辑。**目的是避免循环依赖**：`compactSeedBuilder` 已要 `projectFallbackDocs` 的 `stripProjectDocs`，若 `projectFallbackDocs` 又反向取 builder 的脱敏函数就成环。抽到无内部依赖的叶子模块，两边都依赖它。`redactSensitive`（全集）与抽取前逐字节一致 → builder 行为零变化、零回归。

```ts
/**
 * Single source of truth for secret redaction.
 *
 * Two tiers:
 *  - HIGH_CONFIDENCE: keys with a distinctive prefix/structure. Practically
 *    impossible to false-positive on legitimate prose / doc examples.
 *  - GENERALIZED: `name=value` shapes. Higher recall but may clobber a doc
 *    that *explains* `password=...`; only applied to conversation content.
 *
 * `redactSensitive` (full set) is byte-for-byte identical to the pre-extraction
 * implementation in compactSeedBuilder — no behavioural change.
 */
type Pattern = readonly [RegExp, string];

export const HIGH_CONFIDENCE_SECRET_PATTERNS: Pattern[] = [
    [/sk-(?:ant-)?[A-Za-z0-9_\-]{20,}/g, '[REDACTED-API-KEY]'],
    [/\bghp_[A-Za-z0-9]{30,}/g, '[REDACTED-GH-PAT]'],
    [/\bgithub_pat_[A-Za-z0-9_]{50,}/g, '[REDACTED-GH-PAT]'],
    [/\bxox[abprs]-[A-Za-z0-9\-]{10,}/g, '[REDACTED-SLACK]'],
    [/\bAKIA[0-9A-Z]{16}\b/g, '[REDACTED-AWS]'],
    [/\beyJ[A-Za-z0-9\-_]{10,}\.[A-Za-z0-9\-_]{10,}\.[A-Za-z0-9\-_]{10,}\b/g, '[REDACTED-JWT]'],
];

export const GENERALIZED_SECRET_PATTERNS: Pattern[] = [
    [/(Authorization\s*:\s*)(?:Bearer|Basic|Token)\s+\S+/gi, '$1[REDACTED]'],
    [/\b((?:api[_-]?key|secret|access[_-]?token|password|passwd|auth[_-]?token|bearer|client[_-]?secret)["']?\s*[:=]\s*["']?)([A-Za-z0-9_\-+=/.~]{8,})/gi, '$1[REDACTED]'],
];

function applyPatterns(text: string, patterns: Pattern[]): string {
    if (!text) return text;
    let result = text;
    for (const [re, replacement] of patterns) result = result.replace(re, replacement);
    return result;
}

/** Full set — for conversation content (compactSeedBuilder). */
export const redactSensitive = (text: string): string =>
    applyPatterns(text, [...HIGH_CONFIDENCE_SECRET_PATTERNS, ...GENERALIZED_SECRET_PATTERNS]);

/** High-confidence only — for the user's authoritative project doc. */
export const redactHighConfidenceSecrets = (text: string): string =>
    applyPatterns(text, HIGH_CONFIDENCE_SECRET_PATTERNS);
```

### ② 新建 `src/codex/utils/projectFallbackDocs.ts`

```ts
/**
 * Project-level fallback-compact docs: <cwd>/.happy/on-fallback-compact.md.
 *
 * Read fresh from disk on every fallback compaction and appended (wrapped in
 * PROJECT_DOCS sentinels) to the seed, so the user's authoritative project
 * context survives every /compact. The next compaction's seed builder strips
 * the wrapped block (stripProjectDocs) — the doc lives on disk, never in the
 * rollout, so it never accumulates into the compacted bucket.
 */
import { promises as fsp } from 'node:fs';
import { join } from 'node:path';
import { logger } from '@/ui/logger';
import { redactHighConfidenceSecrets } from './redactSecrets';

export const FALLBACK_DOC_DIRNAME = '.happy';
export const FALLBACK_DOC_FILENAME = 'on-fallback-compact.md';
export const PROJECT_DOCS_OPEN = '<!--HAPPY-PROJECT-DOCS-v1-->';
export const PROJECT_DOCS_CLOSE = '<!--/HAPPY-PROJECT-DOCS-v1-->';

/**
 * Independent of the seed's 12K-token budget. seed ≤ 48K chars (12K tok × 4),
 * docs ≤ 16K chars (≈4K tok) ⇒ combined ≈ 20K tok ≈ 7.8% of codex's 256K
 * window (same budget framing as compactSeedBuilder DEFAULT_TOKEN_BUDGET).
 * Override via HAPPY_FALLBACK_DOCS_MAX_CHARS.
 */
export const DEFAULT_DOCS_MAX_CHARS = Number(process.env.HAPPY_FALLBACK_DOCS_MAX_CHARS) || 16_000;

/** Break only *complete* sentinel strings so the doc body can't forge a
 *  boundary that stripProjectDocs would mis-cut. Bare mentions of the core id
 *  in prose are left intact. */
function sanitizeSentinels(body: string): string {
    return body
        .split(PROJECT_DOCS_OPEN).join('<!--happy-docs-open(escaped)-->')
        .split(PROJECT_DOCS_CLOSE).join('<!--happy-docs-close(escaped)-->');
}

/** Truncate on a line boundary and balance a dangling code fence so the
 *  injected block never leaks an unterminated ``` into the next turn. */
function truncateAtBoundary(body: string, maxChars: number): string {
    if (body.length <= maxChars) return body;
    let cut = body.slice(0, maxChars);
    const nl = cut.lastIndexOf('\n');
    if (nl > maxChars * 0.5) cut = cut.slice(0, nl);
    if ((cut.match(/```/g)?.length ?? 0) % 2 === 1) cut += '\n```';
    return `${cut}\n\n> ⚠️ 项目文档超长，已按行边界截断（保留头部）。`;
}

/**
 * Load + render the project doc, or '' if absent/empty/unreadable.
 * Fixed order: read → strip BOM → trim → sanitize sentinels → high-confidence
 * redact → boundary truncate → wrap. Truncation runs *after* sanitize so no
 * half-sentinel can appear at the cut.
 */
export async function loadFallbackCompactDocs(
    cwd: string,
    maxChars: number = DEFAULT_DOCS_MAX_CHARS,
): Promise<string> {
    const path = join(cwd, FALLBACK_DOC_DIRNAME, FALLBACK_DOC_FILENAME);
    let raw: string;
    try {
        raw = await fsp.readFile(path, 'utf-8');
    } catch (err) {
        logger.debug(`[projectFallbackDocs] no docs at ${path}: ${(err as Error).message}`);
        return '';
    }
    const trimmed = raw.replace(/^\\uFEFF/, '').trim();
    if (!trimmed) return '';

    const body = truncateAtBoundary(
        redactHighConfidenceSecrets(sanitizeSentinels(trimmed)),
        maxChars,
    );
    return [
        '', '',
        PROJECT_DOCS_OPEN,
        `## 项目固定上下文（来自 ${FALLBACK_DOC_DIRNAME}/${FALLBACK_DOC_FILENAME}，每次 fallback 压缩自动重注入）`,
        body,
        PROJECT_DOCS_CLOSE,
    ].join('\n');
}

/**
 * Remove every PROJECT_DOCS block (sentinels + content). Tolerant: handles
 * multiple pairs; an unmatched OPEN drops to end-of-string (a corrupted
 * injection is safer dropped than half-kept). Used by the seed builder's
 * SEED_SENTINEL branch to break the docs' path into the compacted bucket.
 */
export function stripProjectDocs(text: string): string {
    if (!text.includes(PROJECT_DOCS_OPEN)) return text;
    let out = text;
    for (;;) {
        const open = out.indexOf(PROJECT_DOCS_OPEN);
        if (open < 0) break;
        const closeFrom = open + PROJECT_DOCS_OPEN.length;
        const close = out.indexOf(PROJECT_DOCS_CLOSE, closeFrom);
        const end = close < 0 ? out.length : close + PROJECT_DOCS_CLOSE.length;
        out = out.slice(0, open) + out.slice(end);
    }
    return out.trimEnd();
}
```

### ③ 改 `src/codex/utils/compactSeedBuilder.ts`

- **删除**本地 `SENSITIVE_PATTERNS`（L276-293）与 `redactSensitive`（L295-302）。
- **顶部新增 import**：

```ts
import { redactSensitive } from './redactSecrets';
import { stripProjectDocs } from './projectFallbackDocs';
```

- **`SEED_SENTINEL` 分支**（L361-374）存 `lastCompacted` 前剥离 docs：

```ts
if (text.startsWith(SEED_SENTINEL)) {
    flushCurrentTurn(state);
    const cleaned = stripProjectDocs(text);   // ← 剥离重注入的 .happy docs，防累积
    buckets.lastCompacted = {
        message: 'happy-injected seed',
        replacement_history: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: cleaned }] }],
    };
    buckets.allTurns = [];
    return;
}
```

> `redactSensitive` 的两处调用（L378、L388）保持不变，现在从 `redactSecrets` import。

### ④ 改 `src/codex/runCodexAppServer.ts`

- **顶部 import**：

```ts
import { loadFallbackCompactDocs } from './utils/projectFallbackDocs';
```

- **闭包顶部抽 SSoT**（`compactState` 定义附近，约 L454）：

```ts
// SSoT for the codex session working dir — also used by sandbox writableRoots
// and the turn-message cwd. .happy/ docs are resolved relative to it.
const sessionCwd = process.cwd();
```

  并把现有 `process.cwd()`（L1376 turn cwd、L1417 sandbox writableRoots）改用 `sessionCwd`——**等值替换，无行为变化**。

- **`runManualCompact` 内 `if (mode === 'compact')` 块末尾**（约 L616 注释后、L617 `}` 前，此时 `seedText` 已是 L2 成功/失败/short_circuit 的最终值）：

```ts
        // 附加项目级 fallback 文档（每次压缩从磁盘重读），用 PROJECT_DOCS 哨兵
        // 包裹，使下一轮 seed builder 剥离它而非累积进 compacted bucket。
        const projectDocs = await loadFallbackCompactDocs(sessionCwd);
        if (projectDocs) {
            seedText += projectDocs;
            logger.debug(`[CodexAppServer] ${autoTriggered ? '[auto] ' : ''}/compact appended .happy docs (${projectDocs.length} chars)`);
        }
    }   // ← 原 L617；仅 compact 进入，/clear 天然跳过
```

---

## 9. 模块依赖图（无环）

```
redactSecrets.ts        (叶子，无 happy 内部依赖)
   ↑                ↑
projectFallbackDocs.ts  │
   ↑                    │
compactSeedBuilder.ts ──┘
   ↑
runCodexAppServer.ts
```

---

## 10. 边界与降级行为

| 情况 | 行为 |
|---|---|
| 无 `.happy/` 或文件不存在 | 返回 `''`，零副作用 |
| 文件空 / 纯空白 / 仅 BOM | 返回 `''` |
| 读失败（权限 / 是目录 / symlink 循环） | `catch` → `''` + debug log |
| 文档超 16K 字符 | 行边界截断 + 平衡代码围栏 + 尾标警告（保留头部） |
| 文档含完整哨兵串 | `sanitizeSentinels` 打断，`stripProjectDocs` 不误截 |
| 文档含高置信密钥 | 脱敏为 `[REDACTED-*]` |
| `/clear` | 跳过（不进 `mode === 'compact'` 块） |
| 文档含未闭合 ``` 围栏 | 截断路径平衡围栏；完整路径原样（用户责任） |

---

## 11. 测试计划

| 测试文件 | 覆盖 |
|---|---|
| `redactSecrets.test.ts`（新） | 逐条断言 8 个模式；**回归断言** `redactSensitive` 全集 == 搬移前行为；`redactHighConfidenceSecrets` 不动 `name=value` |
| `projectFallbackDocs.test.ts`（新） | 缺失/空/BOM/正常/超长（行边界+围栏平衡）/含完整哨兵被 sanitize/高置信脱敏；`stripProjectDocs` 成对移除、多对、only-open 删到末尾、无哨兵原样 |
| `compactSeedBuilder` 扩展 | 构造"以 `SEED_SENTINEL` 开头、内含 docs 哨兵块"的 rollout 行 → `buildHeuristicSeed` → 断言 compacted bucket **不含**文档正文（防膨胀回归） |
| `autoResumeAfterFallback.test.ts` AST 契约 | `runManualCompact` 存在 `loadFallbackCompactDocs` 调用，且位于 `compactState.pendingSeedText = seedText` 之前 |

> 注：`runCodexWithAppServer` 端到端测试仍受 `__tests__/testkit/README.md` 记录的架构墙阻塞（需 Option B），集成层只能用 AST 契约——与现有 fallback 测试策略一致。

---

## 12. 设计权衡与备选（为什么不那样做）

- **为什么仅 `cwd` 不向上查找**：简单可预测；用户已选定。代价：从子目录启动时找不到（可接受）。
- **为什么单文件不扫描目录**：契约清晰、实现简单；用户已选定。
- **为什么文件名 `on-fallback-compact.md`**：专一、绑定 compact 用途，避免 `context.md` 这类通用名让人误以为平时也读。
- **为什么独立哨兵 + 下一轮剥离，而非直接拼进 seed**：直接拼会让文档被下一轮当作 `compacted` 内容吞进 bucket，占用压缩预算（受 0.30 cap 截断）、与重新读盘的新副本重复、多轮累积噪音。独立哨兵 + 剥离彻底切断这条累积路径。
- **为什么高置信脱敏而非全脱敏**：全脱敏会误伤文档里讲解 `password=...` 之类的 `name=value` 示例；高置信模式（独特前缀/结构）几乎不误伤，同时闭合密钥落盘缺口。
- **为什么抽出 `redactSecrets.ts`**：让 docs 复用脱敏的朴素写法会造成 `compactSeedBuilder ⇄ projectFallbackDocs` 循环依赖（触发可维护性硬性降分）。叶子模块规避。
- **为什么仅 compact 注入而非每轮注入**：需求即"仅 fallback 压缩时"；codex 已有 `AGENTS.md` 承担每轮项目记忆，本特性不与之重复，平时零 token 开销。

---

## 13. 已知限制与未来工作（均为 P2，不阻塞）

1. **读盘时机**：文档在 compact 时刻读盘，而非下一轮注入时刻。手动 `/compact` 后、发下条消息前若改文档，注入的是 compact 时刻的旧版（auto-rescue 立即续接，无此窗口）。移到注入点更新鲜，但需让 docs 与 seed 解耦、每轮 turn 判断，复杂度显著上升——窗口近乎不存在，暂不做。
2. **`.happy` 与用户级 `~/.happy` 撞名**：用户在 home 目录运行时两者重合。实际无危害（只读一个特定文件名，不存在即降级）。
3. **`redactSensitive` 单测欠债**：原本嵌在 `compactSeedBuilder` 无独立测试；抽到 `redactSecrets.ts` 后顺带补齐（已纳入测试计划）。
4. **端到端集成测试**：受架构墙阻塞，集成层仅 AST 契约覆盖。

---

## 14. 评审收敛记录（3 轮 plan-review）

| 轮次 | 方案 | 分数 | 本轮 P0/P1 发现 | 动作 |
|---|---|---|---|---|
| Round 1 | v1 | 36/50 | 哨兵逃逸污染 compacted；docs 绕过脱敏落盘 | 修；并经关联审查识破"复用脱敏→循环依赖"陷阱 |
| Round 2 | v2 | 41/50 | markdown 硬截断破坏代码围栏 | 修；确认原 4 个 🔴 已清且**无回归**（脱敏全集行为不变） |
| Round 3 | v2.1 | **43/50** | 无 | **收敛**：连续攻击无 P0/P1，无无负作用改进可提，未触发回归 |

最终维度分：正确性 9 / 健壮性 9 / 性能 8 / 可维护性 9 / 行业最优 8 = **43/50 ⭐⭐⭐⭐**。

行业对标：Claude Code `CLAUDE.md`、Cursor `.cursor/rules/*.md`、codex `AGENTS.md`（均为每轮 system 注入的项目记忆）；LangChain `ConversationSummaryBufferMemory`（verbatim recent tail + bounded summary，已被 `compactSeedBuilder` 对标）。本方案差异：仅 fallback 压缩时注入 seed 尾部 + 独立哨兵剥离防膨胀，是针对 codex"无压缩时项目锚点"的特化。

---

## 15. 落地检查清单

- [ ] 新建 `src/codex/utils/redactSecrets.ts`
- [ ] `compactSeedBuilder.ts` 删除本地脱敏定义，改 import（确认 L378/L388 调用不变）
- [ ] 新建 `src/codex/utils/projectFallbackDocs.ts`
- [ ] `compactSeedBuilder.ts` `SEED_SENTINEL` 分支接入 `stripProjectDocs`
- [ ] `runCodexAppServer.ts` 抽 `sessionCwd` + 三处引用统一 + `runManualCompact` 末尾附加
- [ ] 4 个测试文件 / 扩展
- [ ] `npx vitest run` 三个相关测试文件全绿（含 `redactSensitive` 回归断言）
- [ ] 手动验证：建 `.happy/on-fallback-compact.md` → `/compact` → 看日志 `appended .happy docs (N chars)` → 新 thread 首轮含项目文档；二次 `/compact` 看 compacted bucket 不含文档正文
