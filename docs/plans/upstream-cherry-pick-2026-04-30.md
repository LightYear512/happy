# Upstream 跟踪与 cherry-pick 计划（2026-04-30）

> 日期：2026-04-30
> 作者：an
> 状态：**调研完成，待执行**
> 基线：dev-main-v2 HEAD = `31994508`，upstream/main HEAD = `df4cdae8`，merge-base = `beffdc81`（2026-04-08）

---

## 1. 三条路线的事实定位

我们与 upstream / happier 实际是 **三个并行项目**，不是 fork-上游关系。

| | upstream `slopus/happy` | 我们 `dev-main-v2` | happier-dev/happier |
|---|---|---|---|
| 与我们 merge-base | `beffdc81` (2026-04-08) | — | `3ed8b121` (2026-01-28) |
| 自分叉以来 commits | 201 | 27 | 5523（共同分叉点起） |
| 节奏（c/d） | ~9.1 | ~1.2 | ~60 |
| 战略重心 | `packages/codium`（桌面 Codex 克隆，128 文件全新包） | bang/profile/CCS、GMS 可选、EAS、daemon 加固 | 全栈重写到 `apps/cli/src/backends/codex/` 二十多子模块 |
| 部署形态 | mobile + 桌面端 | mobile + 国内/Android/Windows | 多环境 CI/CD 正式产品 |
| AppServer 设计 | 集中在 `codexAppServerClient.ts`（1215 行） | 二次抽象拆 `runCodexAppServer / appServerStreamBridge / codexMcpClient`（590+1065+431+479 行） | `appServer/{runtime, streamEventBridge, nativeFork, ...}` |

**结论**：
- ❌ 不可整体 rebase upstream — 33 文件重叠，5 个 hot file 双方都改 200+ 行
- ❌ 不向 upstream 提 codex AppServer 重构 PR — 巨型 commit + 维护者注意力不在这
- ❌ 不向 happier 提 PR — 路径/命名空间不兼容，且他们已经做得比我们更深
- ✅ **第三条路线**：从 upstream 选择性 cherry-pick 通用修复，happier 仅作架构参考

---

## 2. 候选池（32 个 commit）

排除原则：codium 桌面端、Pierre diffs（设计语言切换 50+ 文件）、tauri、LiveKit voice（我们走自家 voice token）、multi-process / Redis streams（upstream 已 revert `325d10752`）。

### 2.1 第一批 — 直接 cherry-pick（15 个，clean）

| SHA | 发布物 | 一句话 | 优先级 |
|---|---|---|---|
| `8786195b` | APP (OTA) | 移除生产环境 console 打印凭据（合规） | P0 |
| `d92e6c64` | CLI | Gemini safe-yolo 安全 bug — 之前对所有工具放行 | P0 |
| `313a4706` | APP (OTA) | machines sync hang → 永久白屏 | P0 |
| `6036fec6` | CLI | logger 用 util.inspect 暴露 Error stack | P0 |
| `e9f0fa37` | CLI | daemon 自重启时先释放再 spawn — 防失踪 | P0 |
| `1708d132` | CLI | 识别 Claude Code 2.1.113+ 原生二进制 | P0 |
| `336b8002` | CLI | plan mode 自动放行只读 + 切 session 重置 permissionMode | P0 |
| `936947cc` | CLI | claudeLocal 测试 mock 改 cross-spawn（**必须和 b3d38e7a 同拣**） | P0 |
| `42822d25` | SERVER | token 缓存 TTL + 上限 + 周期清理 | P0 |
| `d2e61530` | APP (OTA) | worktree spawn 暴露真错（不再笼统 'Not a Git repository'） | P1 |
| `8dbd2ccb` | APP (OTA) | 关闭 KeyboardProvider 预加载 — 防启动幻影键盘 | P1 |
| `962c5556` | APP (OTA) | session 列表稳定按 createdAt 排序 | P1 |
| `31857fc7` | APP (OTA) | 'build'/'plan' 模式名首字母大写 | P1 |
| `43cc8b50` | CLI | Windows 路径校验 path.sep（影响 Windows 文件 sidebar） | P1 |
| `726fdf77` | DOCKER | standalone Dockerfile 设置 WORKDIR 让 tsx 解析 `@/*`（仅自托管） | P2 |

### 2.2 第二批 — 单文件冲突（11 个，每个 5-15 分钟解）

| SHA | 发布物 | 一句话 | 冲突文件 |
|---|---|---|---|
| `b3d38e7a` | CLI | Windows spawn ENOENT + daemon 重启死循环 | `claudeLocal.ts` + `daemon/run.ts` + `daemon/controlClient.ts` |
| `708b8329` | APP+CLI | codex auto-approve 越权（Set.has 替 .includes）+ permissionMode 校验 + 移动端 modelMode/effortLevel 持久化 | `runCodex.ts` + `permissionHandler.ts` |
| `f169857b` | CLI | codex task 失败暴露给客户端 — **先确认我们 errorFormatter.ts 是否覆盖** | `runCodex.ts` |
| `cd7e0a9d` | CLI | daemon 启动竞态 + webhook 重试 | `daemon/controlClient.ts` |
| `c744ae20` | SERVER | socket auth 移到 middleware — 消除 RPC 注册竞态 | `server/socket.ts` |
| `fb33bffc` | SERVER | 跨 replica fetchSockets 超时 500ms→2s | `server/rpcHandler.ts` |
| `b90d07b0` | CLI | sessions.json 原子写（temp + rename） | `persistence.ts` |
| `ca3b6e6d` | APP (OTA) | Opus 4.7 + GPT 5.5 模型选项（codium 那行丢弃） | `modelModeOptions.ts` |
| `239bf90d` | APP (OTA) | iOS markdown 表格不再纵向延伸吞滚动手势 | `MarkdownView.tsx` |
| `85e51c9a` | APP (OTA) | dark theme 滚动条可见 | `theme.css` |
| `6d27316d` | APP (OTA) | scroll-to-bottom 按钮重设计（设计向，可选） | `ChatList.tsx` + `.gitignore` |

### 2.3 第三批 — 不 cherry-pick，仅作 review checklist（6 个）

这 6 个全部撞我们 `0954644a feat(api): extend session machine with encryption and pending-message hooks` + `021fa322 feat(resume): add agent auth flow for session resumption`，两条路线殊途同归不能混。

| SHA | upstream 路线 | 待 review 的边界 |
|---|---|---|
| `8b951c56` | codex resume + inline button | 我们 UI 是否提供 inline resume 按钮 |
| `80d1b39e` | sessions.json 持久化 encryption keys + 14 天 prune | 我们重启后能否 resume 旧 session？stale 清理逻辑？ |
| `8735f817` | daemon 存 keys，resume RPC 永远注册 | suppress archived signal / skip old messages / fetch fresh metadata 是否覆盖 |
| `c2d0f6ec` | in-place resume via env var，保留消息历史 | HAPPY_RECONNECT_* env 流程我们是否实现 |
| `d58701e4` | 重连改 single-shot → 3s polling | 我们的重连策略是否 single-shot |
| `23e6e3b1` | lid-closed Power Nap 僵尸重连防御（macOS） | 我们是否测过 macOS Power Nap 场景 — 大概率没测过 |

---

## 3. 推荐发布节奏

| 节拍 | 发布物 | 内容 | 时间 |
|---|---|---|---|
| W1 D1 | CLI patch | P0 全部 + P1 CLI（合计 9-11 个）+ npm publish | 1-2 天 |
| W1 D1 | SERVER | 3 个 commit + redeploy（向后兼容，零停机） | 半天 |
| W1 D2 | APP OTA | P0 + P1 APP（合计 7-8 个）+ EAS Update | 半天 |
| W2 | DOCKER（可选） | `726fdf77` | 半天 |
| W2 | Review 笔记 | 第三批 6 个对照 0954644a + 021fa322 | 1 天 |

> 顺序底层逻辑：CLI 必须最早 — 移动端 OTA 依赖 CLI 端 codex auto-approve 修复才能拉通。

### 3.1 发布物统计

```
CLI    : 14 个 commit  → npm publish (一次 patch 版本即可)
APP    : 11 个 commit  → 全部 OTA 可达，无 native 改动
SERVER :  3 个 commit  → 容器 redeploy，向后兼容
APP+CLI:  3 个 commit  → 双发（移动端 OTA + cli 包）
DOCKER :  1 个 commit  → standalone 镜像（自托管）
```

---

## 4. 显式跳过的清单（对外 changelog 用得上）

| 类别 | 数量 | 跳过理由 |
|---|---|---|
| codium 桌面端 | ~30 commit | upstream 战略转向，与我们 mobile + CLI 主线无关 |
| Pierre diffs / file-tree sidebar | ~10 commit | 50+ 文件设计语言切换，rebase 成本不收益 |
| tauri 桌面 | ~5 commit | 我们不发桌面 |
| LiveKit voice 系列 | ~6 commit | 我们走自家 voice token + RevenueCat 路线 |
| multi-process / Redis streams | 4 commit | upstream 已 revert（`325d10752`） |
| 第三批 session resume / encryption | 6 commit | 我们 0954644a + 021fa322 已走自家路线 |

---

## 5. 复现命令

### 5.1 重新校准基线

```bash
git fetch upstream --quiet
BASE=$(git merge-base dev-main-v2 upstream/main)
echo "merge-base: $BASE"   # 应为 beffdc81
git rev-list --count $BASE..upstream/main   # ~201
git rev-list --count $BASE..dev-main-v2     # ~27
```

### 5.2 干跑冲突检测（worktree 隔离）

```bash
WT=/tmp/happy-cherrypick-test
git worktree add --detach $WT dev-main-v2
cd $WT
for sha in 313a4706 8dbd2ccb e9f0fa37 ...; do
  git reset --hard dev-main-v2 -q
  git cherry-pick --no-commit $sha 2>&1
  rc=$?
  git cherry-pick --abort 2>/dev/null
  echo "$sha: $([ $rc -eq 0 ] && echo CLEAN || echo conflict)"
done
git worktree remove --force $WT
```

### 5.3 第一批一次性命令

```bash
git checkout -b chore/upstream-pick-cli-p0
git cherry-pick -x \
  d92e6c64 6036fec6 e9f0fa37 1708d132 336b8002 \
  43cc8b50 b90d07b0
# Windows 双件
git cherry-pick -x b3d38e7a 936947cc   # 解 1-2 个冲突
# 跑测试
pnpm --filter happy-cli test
```

```bash
git checkout -b chore/upstream-pick-server
git cherry-pick -x 42822d25
git cherry-pick -x c744ae20 fb33bffc   # 可能需小幅手解
```

```bash
git checkout -b chore/upstream-pick-app-ota
git cherry-pick -x \
  8786195b 313a4706 d2e61530 8dbd2ccb \
  962c5556 31857fc7
git cherry-pick -x ca3b6e6d 239bf90d 85e51c9a 6d27316d   # 简单冲突
```

---

## 6. Follow-up

### 6.1 立即可做（非 cherry-pick）
- 验证 `f169857b` 与我们 `errorFormatter.ts` (commit 8a3aa356) 的覆盖关系，决定是否纳入 P0
- 验证 macOS Power Nap 场景（`23e6e3b1` 提到的）是否复现 — 我们目前未测试

### 6.2 长期跟踪 SOP
- **每两周**跑一次 `git log upstream/main --since=2.weeks` 扫新 fix
- 重点关注：`fix(happy-cli)` `fix(happy-server)` `fix(daemon)` `fix(sync)` 这四个 scope
- 忽略：`feat(codium)` `fix(codium)` `feat(diff)` `feat(file-diffs-sidebar)` `feat(tauri)`

### 6.3 happier 作为架构参考
- 不复制代码，仅作"设计已经走到哪一步"的样本
- 重点学：`apps/cli/src/backends/codex/appServer/` 子目录拆法（`runtime` / `streamEventBridge` / `nativeFork` / `speedEligibility` / `rollbackMetadata` 等命名暗示的边界）

---

## 7. 决策记录

| 决策 | 时间 | 理由 |
|---|---|---|
| 不整体 rebase upstream | 2026-04-30 | 33 文件重叠 + 设计已分叉 |
| 不提 codex AppServer PR 给 upstream | 2026-04-30 | 巨型 commit + upstream 注意力在 codium |
| 不提 PR 给 happier | 2026-04-30 | 路径/命名空间完全不兼容，他们做得更深 |
| 第三条路线 + cherry-pick 模式 | 2026-04-30 | 唯一可持续方案 |
| 第三批 6 个 session resume 不 cherry-pick | 2026-04-30 | 我们 0954644a + 021fa322 已自家实现，混合会撞状态机 |
