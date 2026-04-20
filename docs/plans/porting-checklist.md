# 移植执行 Checklist：pre-v3-clean → dev-main-v2

> 日期：2026-04-15
> 基于分析文档：`resume-dedup-comparison.md`、`merge-pre-v3-clean-to-dev-main-v2.md`
> 执行顺序：严格按编号，后续步骤依赖前置步骤

---

## 阶段一：立即可执行（无 Server / App / DB 变更）

### Step 1：Resume 去重（Stage B 剩余）

> 防幽灵进程。来自 `2b9ca891` + `e83f0265`，依赖已完成的 `--kill-sessions`（requestShutdown 签名变更）。

**涉及文件（均在 `packages/happy-cli/src/`）：**

#### 1a. `daemon/types.ts` — 增加 `resumeTarget`

```diff
export interface TrackedSession {
  startedBy: 'daemon' | string;
  happySessionId?: string;
  pid: number;
  childProcess?: ChildProcess;
+ resumeTarget?: string;   // claudeSessionId of the session being resumed (dedup key)
}
```

同时给 `SpawnSessionResult` 类型增加 `'superseded'`（检查当前 controlServer.ts 中是否有此类型，若无则新增）：

```diff
- export type SpawnSessionResult = 'started' | 'already-running' | ...
+ export type SpawnSessionResult = 'started' | 'already-running' | 'superseded' | ...
```

#### 1b. `daemon/run.ts` — spawn 前检查重复 resumeTarget

spawn 新 CLI 时，若携带 `--resume <claudeSessionId>`，先扫描 `trackedSessions`：
- 如果已有 session 的 `resumeTarget === claudeSessionId`（且进程还活着），返回 `'superseded'`（或 kill 旧进程后继续）
- 记录新 session 的 `resumeTarget = claudeSessionId`

查 `2b9ca891` 的具体 diff：

```bash
git show origin/compat/pre-v3-clean 2b9ca891 -- packages/happy-cli/src/daemon/run.ts
git show origin/compat/pre-v3-clean e83f0265 -- packages/happy-cli/src/daemon/run.ts
```

#### 1c. `daemon/controlServer.ts` — 处理 `superseded` 返回值

spawn 返回 `'superseded'` 时，向调用方返回合适的错误（不崩溃）。

#### 1d. `apiMachine.ts` — 上报 claudeSessionId 给 daemon

CLI 启动后，将自身的 `claudeSessionId` 告知 daemon，供 dedup 使用。

**验证方法：**
```bash
# 快速 spawn 两个 --resume 指向同一 sessionId，确认只有一个存活
./bin/happy.mjs daemon start
```

---

### Step 2：BangCommand 体系升级

> 移植 `!restart`，同时将 dispatcher 升级为带 desc/alias/`!help` 的结构。

**涉及文件（均在 `packages/happy-cli/src/commands/bang/`）：**

#### 2a. `configuration.ts` — 增加 `restartSignalFile`

在 `packages/happy-cli/src/configuration.ts` 的 `Configuration` 类中：

```diff
  public readonly daemonLockFile: string
+ public readonly restartSignalFile: string
  public readonly currentCliVersion: string

  // 在 constructor 中：
  this.daemonLockFile = join(this.happyHomeDir, 'daemon.state.json.lock')
+ this.restartSignalFile = join(this.happyHomeDir, 'restart-signal')
```

#### 2b. `types.ts` — 扩展类型定义

从 pre-v3-clean 合入以下变更（保留现有内容，增量添加）：

- 新增 `export const SEPARATOR = '━━━━━━━━━━━━━━━━━━'`
- `BangCommandContext` 增加两个可选字段：
  ```diff
    session: Session | null;
  + isConsoleSession?: boolean;
  + flavor?: 'claude' | 'codex' | 'gemini';
  ```
  > 注意：`session` 类型暂时保持 `Session | null`，不换成 `BangSessionLike`（避免大范围改动）
- `BangCommandResult.message` 改为支持数组：
  ```diff
  - message: string;
  + message: string | string[];
  + suggestions?: string[];
  ```
- 新增 helper：`parseCodexFlag`、`rejectCodexFlagInSession`（可选，按需添加）

#### 2c. 新建 `restartCommand.ts`

直接从 pre-v3-clean 复制 `packages/happy-cli/src/commands/bang/restartCommand.ts`，**删除** codex/gemini 相关分支（当前 dev-main-v2 不支持 codex），简化为：

```typescript
// restartCommand.ts（简化版，去掉 flavor/codex 逻辑）
import { writeFileSync } from 'node:fs';
import { logger } from '@/ui/logger';
import { getCurrentCcsProfile } from './ccsProfiles';
import { configuration } from '@/configuration';
import type { BangCommandContext, BangCommandResult } from './types';

export async function handleRestartBangCommand(args: string, ctx: BangCommandContext): Promise<BangCommandResult> {
    if (ctx.isConsoleSession) {
        return { message: 'ℹ️ 控制台中请使用 !restart-all 重启全部会话', action: 'none' };
    }
    if (args.trim()) {
        return { message: '!restart 不接受参数', action: 'none' };
    }
    const profile = getCurrentCcsProfile();
    const label = profile ? ` (${profile})` : '';
    return { message: `🔄 正在重启会话${label}`, action: 'restart-session' };
}

export async function handleRestartAllBangCommand(_args: string, _ctx: BangCommandContext): Promise<BangCommandResult> {
    const profile = getCurrentCcsProfile();
    const label = profile ? ` (${profile})` : '';
    try {
        writeFileSync(configuration.restartSignalFile, Date.now().toString(), 'utf-8');
    } catch {
        return { message: '❌ 广播重启信号失败', action: 'none' };
    }
    return { message: `🔄 已广播重启信号到全部会话${label}`, action: 'none' };
}
```

#### 2d. `dispatcher.ts` — 升级注册表结构

从简单 `Record<string, BangCommandHandler>` 升级为带元数据的结构：

```typescript
import { handleRestartBangCommand, handleRestartAllBangCommand } from './restartCommand';
import { SEPARATOR } from './types';

type CommandEntry = {
    handler: BangCommandHandler;
    desc: string;
    sessionOnly?: boolean;
    consoleOnly?: boolean;
    hidden?: boolean;
};

const commands: Record<string, CommandEntry> = {
    auth:        { handler: handleAuthBangCommand,       desc: '切换 CCS 账号', sessionOnly: true },
    restart:     { handler: handleRestartBangCommand,    desc: '重启会话', sessionOnly: true },
    'restart-all': { handler: handleRestartAllBangCommand, desc: '重启全部会话', consoleOnly: true, hidden: true },
    help:        { handler: handleHelpBangCommand,       desc: '显示帮助' },
};

const aliases: Record<string, string> = {
    a: 'auth',
    r: 'restart',
    h: 'help',
};
```

同时：
- 解析 alias（在 `parseBangCommand` 后查 `aliases` 表）
- `!help` 命令自动生成 `!<cmd> → <desc>` 列表（使用 `SEPARATOR`）
- `executeBangCommand` 的 `handler` 改为 `entry.handler`
- `message: string | string[]` 的下游处理（发送时若是数组则逐条发送，需检查 `apiSession.ts` 的 `sendMessage` 是否支持）

#### 2e. 检查 `message: string | string[]` 的下游兼容性

搜索 `.message` 使用处：

```bash
grep -r "result\.message\|\.message\b" packages/happy-cli/src/claude/loop.ts
```

若调用方只接受 `string`，需要在 `executeBangCommand` 出口处拍平：

```typescript
// 临时兼容层（如果 loop.ts 只接受 string）
const msg = Array.isArray(result.message) ? result.message.join('\n') : result.message;
```

---

## 阶段二：方案β（需专项实现）

> 将 agent auth 集成到 `happy auth login`，使 `~/.happy/agent.key` 在 CLI 侧产生。

### Step 3：方案β — CLI 侧 agent auth

**目标：** `happy auth login` 扫完 CLI 二维码后，追加一次 agent auth 二维码扫描，写入 `~/.happy/agent.key`。

**关键参考文件（均在 pre-v3-clean）：**

| 文件 | 作用 |
|------|------|
| `packages/happy-agent/src/auth.ts` | QR 扫码流程（`/v1/auth/account/request`） |
| `packages/happy-cli/src/resume/localHappyAgentAuth.ts` | 读取 `agent.key`，派生 `contentKeyPair` |
| `packages/happy-cli/src/resume/resolveHappySession.ts` | 用 agent token 调 GET /v1/sessions |

**实现步骤：**

1. 在 `configuration.ts` 增加 `agentKeyFile: join(happyHomeDir, 'agent.key')`
2. 提取 `happy-agent/src/auth.ts` 中的 `requestAgentAuth(serverUrl)` 逻辑到 `packages/happy-cli/src/auth/agentAuth.ts`
   - 使用 `/v1/auth/account/request` 端点（与 CLI auth `/v1/auth/request` 不同）
   - 显示二维码 → 轮询 → 写 `~/.happy/agent.key`
3. 在 `packages/happy-cli/src/commands/loginCommand.ts`（或 `ui/start.ts`）的 auth 完成后调用 `requestAgentAuth()`
   - 用户体验：两个二维码顺序显示，第一个 CLI auth，第二个 agent auth
4. Server/App 零变更（`/v1/auth/account/request` 端点已存在）

**工作量估计：** ~100 行新代码，集中在 happy-cli 侧。

---

### Step 4：`!sessions` / `!resume` 命令（依赖 Step 3）

依赖 `agent.key` 存在后实现：

```
!sessions      → GET /v1/sessions（用 agent.key 解密 metadata）→ 列出所有 session
!resume <id>   → 解密 metadata → RPC resume-happy-session
```

参考：`packages/happy-cli/src/resume/resolveHappySession.ts`（upstream 已有）。

---

### Step 5：`killProcessTree` 跨平台移植（独立可做）

> Windows 上 kill 僵尸进程。独立于以上步骤，可随时移植。

**来源：** pre-v3-clean 中的 `killProcessTree` 函数（在 `daemon/run.ts` 或 `utils/` 中）。

```bash
git show origin/compat/pre-v3-clean -- packages/happy-cli/src/daemon/run.ts | grep -A20 "killProcessTree"
```

移植到 `packages/happy-cli/src/utils/killProcessTree.ts`，在 daemon session 清理时调用。

---

## 不执行项（已确认跳过）

| 项 | 理由 |
|----|------|
| `!open` / `!session` 移植 | pre-v3-clean 自己也暂停了，待 multi-backend 重构后重新设计 |
| `!login` 移植 | upstream 重构后 +787 行，依赖链复杂，延后 |
| `!usage` 移植 | 依赖 `usageCommand.ts` 不存在 |
| `!title` 移植 | upstream 已删除该 RPC |
| 明文上报方案 | 不引入，使用 upstream 的 agent.key 加密方案 |
| Codex 支持 | 不在当前评估范围 |
| macOS Keychain | 等 macOS 开发环境就绪 |
| happy-agent 整包合入 | 以 upstream 版本为准 |

---

## 执行顺序总结

```
Step 1：Resume 去重（~2h）
  └─ 1a types.ts + 1b run.ts + 1c controlServer.ts + 1d apiMachine.ts

Step 2：BangCommand 体系（~3h）
  └─ 2a configuration.ts
  └─ 2b types.ts
  └─ 2c restartCommand.ts（新建）
  └─ 2d dispatcher.ts
  └─ 2e 下游兼容验证

---- 方案β 专项（独立 sprint）----

Step 3：agent auth in CLI（~4h）
Step 4：!sessions / !resume（~2h，依赖 Step 3）
Step 5：killProcessTree（~1h，随时可做）
```
