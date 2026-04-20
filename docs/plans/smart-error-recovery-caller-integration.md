# Smart Error Recovery — Caller 集成方案

> 日期：2026-04-17
> 来源：pre-v3-clean `d9395294` (+417/-37 across 7 files)
> 前置：`errorFormatter.ts` + `.test.ts` 底座已在 dev-main-v2 落地（30/30 测试绿，build 全绿）
> 状态：⏸ 待排期 — 本文档为独立 sprint 任务说明

---

## 1. 背景

`merge-pre-v3-clean-to-dev-main-v2.md` 阶段 D Smart error recovery 盘点结论：
- ✅ `errorFormatter.ts` 底座已移植（`ErrorSeverity` / `ErrorFormatResult` / `formatErrorForUser`）
- ✅ `queryRateLimitContext()` 已在 `usageCommand.ts:646`
- ✅ `claudeRemoteLauncher.ts` 存在（但未接入 errorFormatter）
- ❌ caller 集成未做 —— 本文档描述如何闭环

**价值**：API 错误（429 quota / auth / transient）到达 App 时显示带 severity 标签 + recoverySteps 的文案，而不是裸 stack trace；429 自动触发 usage 查询显示可切换 profile。

---

## 2. 上游参考（d9395294）

3 个关键集成点的 pre-v3-clean 行号（通过 `git show origin/compat/pre-v3-clean:<path>` 获取）：

| 文件 | pre-v3-clean 位置 | 作用 |
|------|-------------------|------|
| `claude/runClaude.ts` | L31 `import formatErrorForUser` | 顶层入口 |
| `claude/runClaude.ts` | L32 `import queryRateLimitContext` | 启动期 usage 检查 |
| `claude/runClaude.ts` | L305 `await queryRateLimitContext()` | 启动后非阻塞 warning |
| `claude/runClaude.ts` | L564 `formatErrorForUser(String(error))` | 顶层 catch 格式化 |
| `claude/claudeRemoteLauncher.ts` | +83 行 | 接入 `onRateLimitEvent` 回调 |
| `claude/utils/sdkToLogConverter.ts` | L16 / L146 / L198 | SDK message 错误文本格式化 |

---

## 3. dev-main-v2 架构差异（必读，决定集成方式）

### 3.1 错误流不一致

| 节点 | pre-v3-clean | dev-main-v2 |
|------|-------------|------------|
| `sdkToLogConverter` `case 'result'` | 转 assistant 消息 + `formatErrorForUser` 格式化 | `break`，**根本不显示** |
| `sdkToLogConverter` `case 'assistant'` | 处理 `isApiErrorMessage` sanitize | 无此分支（`types.ts:33` 只有注释） |
| `claudeRemoteLauncher.ts:434` | （不同实现） | `sendSessionEvent({ message: 'Process exited unexpectedly' })` 固定字符串 |

### 3.2 结论

**不能直接照搬 pre-v3-clean 的 patch** —— 接入 `case 'result'` 的 formatErrorForUser 等于**改变 dev-main-v2 的消息流语义**（让 result 消息开始显示给用户）。

### 3.3 推荐集成点（dev-main-v2 本土化方案）

1. **`claudeRemoteLauncher.ts:434`** — 固定字符串 `'Process exited unexpectedly'` 换成：
   ```ts
   const formatted = formatErrorForUser(String(e));
   session.client.sendSessionEvent({ type: 'message', message: formatted.display });
   ```
   前置：确认 `e` 在 catch 里是否包含原始 API 错误文本；如果只是 JS Error 对象，需要上游把 SDK 的错误原文捕获透传下来。

2. **`runClaude.ts` 启动期** — 新增 usage warning（参考 pre-v3-clean L305）：
   ```ts
   queryRateLimitContext().then(ctx => {
     if (ctx && ctx.severity >= 'caution') {
       api.sendSessionMessage({ ...warning text... });
     }
   }).catch(() => {}); // non-blocking
   ```
   `queryRateLimitContext` 已在 `usageCommand.ts:646`，但**当前无人调用它**。

3. **SDK `onRateLimitEvent` 回调**（参考 pre-v3-clean claudeRemoteLauncher +83 行）—— 订阅 SDK rate_limit_event，触发 `queryRateLimitContext` 联动。

4. ⚠️ **暂不接入 `sdkToLogConverter`** —— 改动 `case 'result'` / `case 'assistant'` 会改变消息显示语义，超出 caller 集成范围。

---

## 4. 执行顺序建议

1. **Step 1**：先摸清 `claudeRemoteLauncher.ts:430` catch 块的 `e` 里到底有什么（运行时加 `logger.debug(JSON.stringify(e))` 打一轮日志）
2. **Step 2**：如果 `e` 有 API 错误原文 → 直接接入 `formatErrorForUser(String(e))`
3. **Step 3**：如果没有 → 先改 `claudeRemote.ts` 把 SDK 原始错误透传上来，再接入
4. **Step 4**：启动期 usage warning（独立低风险）
5. **Step 5**：`onRateLimitEvent` 回调（需 SDK 支持确认）

---

## 5. 验证方法

| 场景 | 触发方式 | 预期 |
|------|---------|------|
| 429 quota | mock rate-limit 响应或真实触发 | App 显示 "Rate limited. Try switching profile..." + recoverySteps |
| Auth 失败 | 失效 token | App 显示 "Authentication failed. Re-login via !login" |
| Transient 网络 | 断网重连 | App 显示 transient 提示，不刷 stack trace |
| 启动期 >=80% usage | mock `queryRateLimitContext` | App 登录后立刻收到 warning |

---

## 6. 风险矩阵

| 风险 | 概率 | 影响 | 缓解 |
|------|------|------|------|
| `e` 不含 API 错误原文 | 中 | 中 | Step 1 先实测，再决定是否重构 SDK 错误传递 |
| 改 SDK 错误透传链路炸 local/codex runner | 中 | 高 | 分 runner 独立验证（remote/local/codex 三份） |
| `onRateLimitEvent` 在当前 SDK 版本不存在 | 低 | 中 | 检查 `@anthropic-ai/claude-code` SDK 版本，必要时升级 |
| 改 `sdkToLogConverter` 泄漏 result 消息 | 高 | 高 | **明确排除在本方案外**（见 3.3.4） |

---

## 7. Scope 边界

**本方案包含**：
- `claudeRemoteLauncher.ts` 错误点接入 `formatErrorForUser`
- `runClaude.ts` 启动期 usage warning
- SDK `onRateLimitEvent` 订阅（如 SDK 支持）

**本方案排除**：
- 改 `sdkToLogConverter` 消息流语义
- 引入 pre-v3-clean 的 `isApiErrorMessage` 合成错误模式
- 跨 runner 的错误处理统一化（independent refactor）

---

## 8. 附录：底座验证命令

```bash
cd packages/happy-cli

# errorFormatter 单测（应 30/30 绿）
npx vitest run src/claude/utils/errorFormatter.test.ts

# 全量 CLI build（应 "Done in XXs"）
yarn build
```
