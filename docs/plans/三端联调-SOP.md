# 三端联调 SOP（Server / CLI Daemon / App-Web）

> 日期：2026-04-28
> 适用范围：让 AI agent（Claude Code 等）能同时控制 server、cli daemon、app-web 三端进行测试运行
> 验证状态：✅ 已用 puppeteer 实测打通（`/tmp/happy-web-probe/out2/summary.json`）

---

## 1. 设计前提

- **AI 不操作真机 / 模拟器 / TUI 终端**。三端联调时 AI 只通过：
  - HTTP（server / daemon API）
  - 浏览器自动化（App-Web，Playwright/Puppeteer）
  - 文件读取（log）
- happy-app 的 React Native Web 投影到 DOM 后**不带 testID / aria-label / role**。selector 必须依赖**可见文本 + placeholder**。
- 真机 App 端用户在用，AI 在另一端通过同一个 session 协同 — **happy 项目本身的远端控制能力反过来当成 AI 接入点**。

---

## 2. 起停三端（一条命令）

### 起

```bash
yarn env:up:authenticated
```

这条命令会：

1. 分配 server / expo 端口
2. 起 server（detached，写 PID）→ HTTP healthcheck 通过
3. 起 web bundler（detached，写 PID）→ Metro `Bundling complete` 或端口绑定（**90 秒超时**，已修复）
4. `yarn build` 编译 CLI（产出 `bin/happy.mjs`）
5. seed：ed25519 keypair → `POST /v1/auth` → 拿 token → 写 `access.key` + `settings.json`
6. spawn daemon（detached），等 `GET /v1/machines` 非空（10s）

总耗时实测 **~91 秒**（首次冷启动 Metro 是大头）。

### 停

```bash
yarn env:down
```

按 PID 文件逐个 SIGTERM：server / web / daemon。

---

## 3. 拿凭据（机读，一步到位）

```bash
yarn env:current --json
```

输出（已剔除敏感值，结构）：

```json
{
  "ok": true,
  "name": "keen-forest",
  "envDir": "/.../environments/data/envs/keen-forest",
  "serverUrl": "http://localhost:53658",
  "webUrl": "http://localhost:53659",
  "authenticatedWebUrl": "http://localhost:53659/?dev_token=…&dev_secret=…",
  "happyHomeDir": "/.../envs/keen-forest/cli/home",
  "happyProjectDir": "/.../envs/keen-forest/project",
  "token": "…",
  "secret": "…",
  "daemon": { "pid": 25354, "alive": true },
  "health": {
    "server": "ok",
    "web": "ok",
    "daemon": "ok",
    "authenticated": true
  },
  "logs": {
    "server": "/.../envs/keen-forest/server/stdout.log",
    "web": "/.../envs/keen-forest/web/stdout.log",
    "daemonDir": "/.../envs/keen-forest/cli/home/logs"
  }
}
```

**用法约定**：每个三端联调 session 第一步都跑这条命令拿快照。`health` 字段必须全 `ok` 才能继续；任一项 `down` 时先排查再操作。

---

## 4. 各端控制方式

### 4.1 Server — Bash + curl

```bash
SNAP=$(yarn env:current --json | tail -n +2)
TOKEN=$(echo "$SNAP" | python3 -c 'import json,sys;print(json.load(sys.stdin)["token"])')
SERVER=$(echo "$SNAP" | python3 -c 'import json,sys;print(json.load(sys.stdin)["serverUrl"])')

# 实测可用的端点（来自 4.4 网络抓包）
curl -s -H "Authorization: Bearer $TOKEN" "$SERVER/v1/sessions"
curl -s -H "Authorization: Bearer $TOKEN" "$SERVER/v1/machines"
curl -s -H "Authorization: Bearer $TOKEN" "$SERVER/v1/artifacts"
curl -s -H "Authorization: Bearer $TOKEN" "$SERVER/v1/friends"
curl -s -H "Authorization: Bearer $TOKEN" "$SERVER/v1/feed?limit=100"
```

注：这些 endpoint 是浏览器登录后**实际触发**的，已用 puppeteer network 抓包验证。

### 4.2 App-Web — Playwright/Puppeteer

直接打 `authenticatedWebUrl`，dev_token 已拼在 URL 里，免登录。

**首选工具**：本地系统装了 Chrome 时用 Playwright MCP（`mcp__plugin_playwright_playwright__browser_*`）。
**降级方案**：当 MCP 找不到 Chrome 时用 puppeteer + 内置 Chromium，参考 `/tmp/happy-web-probe/click-new-session.js`。

### 4.3 CLI session — 不直接驾驶，通过 Web 间接

happy 的设计是「用户在 App，CLI 在远端跑」。AI 通过 Web 触发 session 创建 → daemon spawn → CLI 输出回流到 Web。AI 在 Web 端就能看见 CLI 的输出。

**例外**：纯探针验证 CLI 是否启动，读 daemon log 即可（见 4.5）。

### 4.4 Daemon — 直接 Bash

```bash
source "$(yarn env:current --json | python3 -c 'import json,sys;d=json.load(sys.stdin);print(d["envShPath"])')"
happy daemon status
happy daemon stop
```

或者直接读：

```bash
cat $HAPPY_HOME_DIR/daemon.state.json   # pid, machineId, etc.
```

### 4.5 Daemon log

```bash
DAEMON_DIR=$(yarn env:current --json | python3 -c 'import json,sys;print(json.load(sys.stdin)["logs"]["daemonDir"])')
ls -lt "$DAEMON_DIR"/*.log | head -3
tail -f "$DAEMON_DIR"/$(ls -t "$DAEMON_DIR" | head -1)
```

文件名格式：`YYYY-MM-DD-HH-MM-SS-daemon.log`。

---

## 5. Selector 配方（已实测）

happy-app 全仓 0 个 testID，必须用文本/属性定位。**以下 selector 均来自实测**：

| 场景 | Selector（CSS / JS predicate） | 实测状态 |
|------|-------------------------------|---------|
| 主界面：新建会话按钮 | `div[tabindex="0"]` 中 `el.innerText.trim() === "开始新会话"` | ✅ 点击成功，URL → `/new` |
| 新会话页：输入框 | `textarea[placeholder="What would you like to work on?"]` | ✅ 渲染出现 |
| 状态指示器（daemon online） | text 等于 `已连接` | ✅ 可见 |
| 控制台 session 条目 | text 包含 `🖥️ 控制台 -` | ✅ 可见 |
| Last-active 时间 | text 匹配 `最后活跃时间 \d+ 分钟前` | ✅ 可见 |
| 路由判定 | `location.pathname` | ✅ `/` → `/new` |

### Selector 编写约束

1. **优先 placeholder**（最稳定，源码级 prop）
2. **次选可见文本**（中文文本是 happy-app 的契约层）
3. **避免 unistyles_* 哈希类名**（虽然稳定但不语义化）
4. **避免 css-view-g5y9jx / css-text-146c3p1**（react-native-web 自动生成，无意义）
5. 等待页面 ready：`waitForFunction(() => Array.from(document.querySelectorAll('div')).some(d => d.innerText?.trim() === '<目标文本>'))`，timeout 30s

---

## 6. 事件信号清单（判断状态用）

> 「做完某动作后，等什么信号确认到位」

| 动作 | 信号源 | 信号 pattern | 预期延迟 |
|------|--------|--------------|---------|
| `yarn env:up` 完成 | stdout | `Environment "<name>" is up!` | ~90s |
| Web 渲染完成 | DOM | text `开始新会话` 出现 | ~3s after navigate |
| daemon 注册到 server | server API | `GET /v1/machines` 返回非空 | seedEnvironment 内 10s 内 |
| App 看到 daemon | DOM | text `已连接` 出现 | 主界面渲染完即有 |
| 点击「开始新会话」 | URL | `location.pathname === "/new"` | < 1s |
| 进入新会话页 | DOM | `textarea[placeholder="What would you like to work on?"]` 出现 | < 2s |
| daemon spawn CLI session | daemon log | grep `spawnSession` / `Tracking session` | < 3s after server 推送 |
| session 收到消息 | server / DB | `GET /v1/sessions/<id>/messages` 出现新条目 | < 2s |
| session idle | server | `/v1/sessions/<id>` `state` 字段（具体待确认） | 视 model 推理时间 |

---

## 7. 标准联调流程（端到端）

### 7.1 一键 smoke（推荐）

```bash
yarn env:up:authenticated
yarn scenario:three-tier-smoke
yarn env:down
```

`yarn scenario:three-tier-smoke` 会全自动跑完一遍：navigate → click 「开始新会话」→ 填消息 → cmd+enter 提交 → 等 `/session/<id>` 路由 → 等 daemon log 出现 `Spawning session`。输出结构化 PASS/FAIL JSON（exit code 0/1），适合 CI 或日常回归。

### 7.2 手动逐步联调

```
1. yarn env:up:authenticated
2. SNAP=$(yarn env:current --json)            # 拿凭据
3. 检查 SNAP.health 全 ok
4. 用 puppeteer/Playwright 打开 SNAP.authenticatedWebUrl
5. wait for text "已连接"                      # daemon 联通
6. 主界面 click "开始新会话"                   # URL → /new
7. 在 textarea 输入消息，cmd+enter 提交        # URL → /session/<cuid>
8. 监听三处信号：
   - daemon log（grep `spawn-happy-session` 和 `Spawning session`）
   - server API（GET /v1/sessions 出现新条目）
   - web DOM（assistant 消息渲染，依赖本地 Claude 认证）
9. 验证完成 → yarn env:down
```

---

## 8. Prerequisites（首次运行）

| 依赖 | 用途 | 安装方式 |
|------|------|---------|
| `puppeteer` | 浏览器自动化（fixture + 探针）| `npm install --no-save puppeteer`（在仓库根，**不会污染 yarn.lock**），首次会下载 ~150 MB chromium 到本地 cache |
| Claude Code 本地认证 | CLI session 调 Claude SDK 时使用 | 已装 `claude` CLI 并完成登录的开发机即可。CI / Docker 环境需注入 `ANTHROPIC_API_KEY` 或 mount `~/.claude/credentials.json`。**注**：fixture 不断言 assistant 真实回复，仅断言 daemon spawn + 消息接受，所以 fixture **不依赖** Claude 认证 |
| `yarn env:up:authenticated` 必须先跑过 | fixture 不会自己起停环境，便于反复重试 | `yarn env:up:authenticated`（首次 ~90s） |

## 9. 已知限制 / 未来改进

| 项 | 当前状态 | 备注 |
|----|---------|------|
| 直接驾驶 CLI 终端 | ❌ 不支持 | 需要时用 `terminal-emulator` skill 包一层，独立路径 |
| iOS / Android 模拟器自动化 | ❌ 不在范围 | 真机回归用人工 / EAS build TestFlight |
| 已 happier 风格 `--json` CLI | ❌ 未引入 | 评估后决定不抄 happier 那套 |
| testID 加到 happy-app | ❌ 未做 | 当前文本 selector 够用；真要做时按需加 |
| event 信号清单的具体 server endpoint | ⚠️ 部分 | session-idle 等需要后续抓包补全 |

---

## 10. 修复记录

- **environments.ts web 启动 30s → 90s**（2026-04-28）：原 30s 在冷启动 Metro 时必失败（vitest integration suite 实测）。改为 **端口或日志双信号 + 90s 预算**。已实测：`yarn env:up:authenticated` 总耗时 79~92s 通过。
- **environments.ts 加 `current --json`**（2026-04-28）：补凭据 + health 一步到位机读出口。
- **environments/scenarios/three-tier-smoke.cjs**（2026-04-28）：可重放端到端 smoke fixture，断言 session 路由 + 消息 POST + daemon spawn。

## 11. 参考产出物

| 文件 | 用途 |
|------|------|
| `environments/scenarios/three-tier-smoke.cjs` | **可重放 fixture** — 端到端 smoke，结构化 JSON 输出 |
| `/tmp/happy-web-probe/probe.js` | （研发期） 主界面 DOM 探针 |
| `/tmp/happy-web-probe/click-new-session.js` | （研发期） 点击 + 路由探针 |
| `/tmp/happy-web-probe/send-message.js` | （研发期） 完整发消息探针，输出 daemon log delta |
| `docs/plans/merge-pre-v3-clean-to-dev-main-v2.md` | 上游 / 移植策略 |
| `docs/plans/porting-checklist.md` | 移植步骤清单 |
