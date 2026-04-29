# Pre-existing Test Failures（基线盘点）

> 日期：2026-04-28（在 dev-main-v2 commit `cca0f5ba` 上跑出）
> 范围：5 workspace × vitest 全套
> 用途：与本会话 4 commit 隔离责任 — 所有失败均**非本会话引入**（本会话仅动 `environments/`、`docs/`、`package.json`）

---

## 总览

| Workspace | Files | Tests | 状态 |
|-----------|------:|------:|------|
| happy-agent | 9 / 0 fail | 227 / 0 fail | ✅ |
| happy-wire | 2 / 0 fail | 19 / 0 fail | ✅ |
| happy-cli | 60 / **2 fail** | 552 pass / **6 fail** / 14 skip | ⚠️ |
| happy-server | 5 / **1 fail** | 43 pass / **1 fail** | ⚠️ |
| happy-app | 32 / **4 fail** | 442 pass / **10 fail** / 57 skip | ⚠️ |
| **合计失败** | **7 files** | **18 tests** | — |

加上 happy-wire **并行 build race**（dev-only 工具链 bug），共 **8 个独立 issue**。

---

## Issue #1 — happy-cli/src/claude/planMode.integration.test.ts × 3

**类型**：logic / timeout
**严重度**：⚠️ 中（功能性回归，但只在 plan mode 流程触发）

| 测试 | 失败 |
|------|------|
| _1 | `exitPlanModeReceived` assertion false |
| _2 | timeout @ 180s |
| _3 | timeout @ 180s |

**疑似根因**：plan mode 改造（提交 `6ccef2a2 fix(cli): plan mode buttons missing + background tasks blocked` 等之前的修改）后，exit plan mode 信号路径变化但 integration 测试断言没跟上，或 CLI session 在 plan mode 下没正确 emit 结束事件。

**复现**：
```bash
cd packages/happy-cli
npx vitest run src/claude/planMode.integration.test.ts
```

**建议修复**：先在测试里加 debug log，dump SDK/runner 输出，确定 `exitPlanModeReceived` 信号实际有没有发；如果发了但断言写错，改断言；如果没发，去 source 修。

---

## Issue #2 — happy-cli/src/daemon/daemon.integration.test.ts × 1 suite + 3 tests

**类型**：teardown race + cross-test session leakage
**严重度**：⚠️ 中（test isolation 问题，掩盖真实回归）

| 失败 | 表现 |
|------|------|
| suite teardown | `ENOTEMPTY rmdir on home/logs` — 有进程仍持有文件描述符 |
| listDaemonSessions × 3 | length 1→2、20→21、2→3 — 多出一条 session（前一测试的尸体没清干净） |

**疑似根因**：
- daemon 子进程在测试结束时未完全终止，logs 目录还有句柄
- per-suite environment cleanup 没等 daemon 真死

**复现**：
```bash
cd packages/happy-cli
npx vitest run src/daemon/daemon.integration.test.ts
```

**建议修复**：
- `installIntegrationEnvironment` 里 cleanup 阶段加 `await sleep(500)` 或等 PID 真消失再 rmdir
- 或者 daemon stop 改用 SIGTERM + grace + SIGKILL fallback

**注意**：本会话的 30s→90s 修复**已经修了** daemon suite 的 setup-fail；现在暴露的是 setup 起来后内部的 cleanup race，是不同的失败模式。

---

## Issue #3 — happy-server/sources/storage/processImage.spec.ts × 1

**类型**：fixture 文件缺失
**严重度**：📋 低（不影响真实运行时）

**症状**：
```
ENOENT: no such file or directory, open
  '.../happy-server/sources/storage/__testdata__/image.jpg'
```

**疑似根因**：fixture 图片可能被 `.gitignore` 排除（图片二进制），或漏提交。

**复现**：
```bash
cd packages/happy-server
npx vitest run sources/storage/processImage.spec.ts
```

**建议修复**：
- 把 `image.jpg` 提交到仓库（如果 .gitignore 拦了，加 `!__testdata__/` 例外）
- 或在测试里用 sharp 现场生成一张 fixture

---

## Issue #4 — happy-app/sources/components/markdown/parseMarkdownBlock.test.ts × 4

**类型**：测试陈旧（feature 改了测试没改）
**严重度**：📋 低（断言形状过时，不是 logic bug）

**症状**：表格 cell 输出从 `string` 改成 rich object `[{styles, text, url}]`，4 个测试仍然期望 string。

**复现**：
```bash
cd packages/happy-app
npx vitest run sources/components/markdown/parseMarkdownBlock.test.ts
```

**建议修复**：把每个 cell 期望值更新为新的对象数组形状。

---

## Issue #5 — happy-app/sources/components/modelModeOptions.test.ts × 2

**类型**：测试陈旧
**严重度**：📋 低

**症状**：
1. mode key 顺序变了（`acceptEdits` 移位）
2. metadata 不再自动把 `build` / `plan` 首字母大写为 `Build` / `Plan`

**建议修复**：更新测试期望值或者改测试为顺序无关。

---

## Issue #6 — happy-app/sources/sync/modeHacks.test.ts × 3

**类型**：测试陈旧
**严重度**：📋 低

**症状**：`hackMode` 不再 capitalize 小写 build/plan。3 个断言挂在大写期望上。

**建议修复**：把期望值改成原始小写形式（应该和 source 行为对齐）。

---

## Issue #7 — happy-app/sources/sync/settings.spec.ts × 1

**类型**：测试陈旧
**严重度**：📋 低

**症状**：defaults 多了 `voiceBypassToken`、`voiceCustomAgentId` 两个字段，测试期望值漏了。

**建议修复**：补字段或改 toMatchObject 而不是 toEqual。

---

## Issue #8 — happy-wire 并行 build race（dev 工具链）

**类型**：dev tooling
**严重度**：⚠️ 中（影响 vitest matrix 跑全套）

**症状**：vitest 并行跑多 workspace 时，`packages/happy-wire/` 的 `test` script 是 `shx rm -rf dist && tsc --noEmit && pkgroll`。在并行环境下偶尔只生成 `.cjs` + `.d.cts`，缺 `.mjs` + `.d.mts`。然后 happy-server（ESM）找不到 `.mjs` 直接崩。

**复现**：
1. happy-cli/server/app/agent/wire 的 test 脚本同时跑
2. 概率出现 happy-wire dist 不全
3. `Error [ERR_MODULE_NOT_FOUND]: Cannot find module '.../happy-wire/dist/index.mjs'`

**单独跑没问题**：`yarn workspace @slopus/happy-wire build` 完整生成 4 文件。

**建议修复**：
- 选项 A：sub-agent 的 vitest 改成串行跑各 workspace（牺牲速度）
- 选项 B：CI/dev 加一个 prebuild step 先 `yarn workspaces foreach run build`，所有 dist 准备好再跑 test
- 选项 C：调查 pkgroll 在并发下产物不全的根因（可能是 esbuild concurrent write 冲突）

---

## 严重度排序与建议处理顺序

| 顺序 | Issue | 推荐 |
|------|------|------|
| 1 | #2 daemon integration teardown | 修 — 掩盖真实回归风险 |
| 2 | #1 planMode integration | 修 — 真功能性 |
| 3 | #8 happy-wire build race | 修 — 阻塞 CI 全套通过 |
| 4 | #3 image.jpg fixture 缺失 | 修 — 一行 git add |
| 5 | #4-#7 happy-app 测试陈旧 | 批量更新断言 |

---

## 与本会话 4 个 commit 的责任界定

本会话 commit `a1b1f043 / c50eba79 / 22d0f03a / cca0f5ba` 影响范围：

```
docs/plans/*.md                       (纯文档)
environments/environments.ts          (env 起停 + --json)
environments/scenarios/*.cjs          (新增 fixture)
package.json                          (新增 yarn script)
```

**0 个文件触及 packages/*/src/**。所有上述 18 个 test fail + happy-wire build race 都**先于本会话**已存在或在更早的合并中引入。本会话只**修了** 30s→90s 这一个回归（让 daemon/openclaw integration suite 起得来）。
