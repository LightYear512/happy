# Codex 多账号共享目录策略 — 缺陷分析报告

> P9 Tech Lead 交叉分析报告 | 2026-04-11
> 基于 `.codex` 目录结构 + CCS auth 架构 + happy-cli 实现三维交叉验证

---

## 一、架构对比：Claude vs Codex 的共享机制不对称

### CCS Claude 端（完整实现）

```
~/.ccs/
├── instances/<profile>/
│   ├── projects → shared/context-groups/<group>/projects   (symlink)
│   ├── commands → shared/commands                          (symlink)
│   ├── skills → shared/skills                              (symlink)
│   ├── plugins → shared/plugins                            (symlink)
│   ├── settings.json → shared/settings.json                (symlink)
│   ├── session-env → shared/.../continuity/session-env     (deeper mode)
│   ├── file-history → shared/.../continuity/file-history   (deeper mode)
│   └── .anthropic/         (隔离 - auth tokens)
├── shared/
│   ├── commands/  skills/  agents/  plugins/  settings.json
│   └── context-groups/<group>/
│       ├── projects/
│       └── continuity/  (session-env, file-history, todos, shell-snapshots)
```

**CCS SharedManager 提供**：
- `linkSharedDirectories()` — 链接 commands/skills/plugins 等
- `syncProjectContext()` — 按 context group 共享 projects
- `syncAdvancedContinuityArtifacts()` — deeper mode 下共享会话连续性

### happy-cli Codex 端（缺失实现）

```
~/.happy/
└── codex-instances/<profile>/
    ├── auth.json              (隔离 - OK)
    ├── config.toml            (一次性复制 - 问题)
    ├── .env                   (一次性复制 - 问题)
    ├── sessions/              (隔离 - 无共享选项)
    ├── history.jsonl           (隔离 - 无共享选项)
    ├── state_5.sqlite         (隔离 - 重复)
    ├── logs_1.sqlite          (隔离 - 重复)
    ├── models_cache.json      (隔离 - ~234KB 重复)
    ├── cap_sid                (隔离 - 可能冲突)
    ├── .sandbox/              (隔离)
    ├── .sandbox-secrets/      (隔离)
    ├── skills/                (隔离 - 无共享)  ← 与 Claude 不对称
    ├── cache/                 (隔离 - 无共享)
    └── .tmp/plugins/          (隔离 - 无共享)  ← 与 Claude 不对称
```

---

## 二、已确认缺陷列表

### 缺陷 1：Codex 端 shared mode 形同虚设（严重）

**证据**：`loginCommand.ts:performCodexLogin()` (L1118-1302)

```
performCodexLogin() 的完整流程：
1. mkdirSync(codexInstancePath)
2. 复制 config.toml + .env
3. spawn codex login
4. registerProfile(profileName, contextMode, contextGroup)  ← 只写 config.yaml
```

**缺失调用**：
- ❌ 不调用 `linkSharedDirectories(codexInstancePath)` — skills/plugins/commands 不共享
- ❌ 不调用 `syncProjectContext(codexInstancePath, contextMode, contextGroup)` — projects 不共享
- ❌ 无任何 `syncAdvancedContinuityArtifacts()` 等价实现

**影响**：用户在 `!login` 时选择 `shared` 模式，contextMode 和 contextGroup 被写入 config.yaml，但**目录层面没有任何共享行为发生**。shared mode 对 Codex 完全是一个空承诺。

---

### 缺陷 2：配置继承是一次性快照（中等）

**证据**：`loginCommand.ts:1143-1153`

```typescript
// Seed config from current CODEX_HOME so proxy/trust settings carry over
const currentCodexHome = process.env.CODEX_HOME || join(homedir(), '.codex');
for (const file of ['config.toml', '.env'] as const) {
    const destFile = join(codexInstancePath, file);
    if (!existsSync(destFile)) {  // ← 只在文件不存在时复制
        const srcFile = join(currentCodexHome, file);
        if (existsSync(srcFile)) {
            try { copyFileSync(srcFile, destFile); } catch { /* best-effort */ }
        }
    }
}
```

**问题**：
- 创建 profile B 时从 profile A 复制 config.toml/.env
- 之后 A 修改了代理配置（如换了 VPN 端口），B 不会同步
- 用户有 5 个 profile → 每次改代理要手动改 5 份 .env
- **应该用 symlink 而非 copy**（与 CCS Claude 端 settings.json 的做法一致）

---

### 缺陷 3：models_cache.json 重复存储（低）

**证据**：T1 分析显示 models_cache.json 约 234KB

**问题**：
- 每个 Codex 实例独立维护一份 models_cache.json
- 内容完全相同（全局模型列表 + 系统提示词）
- 5 个 profile = 5 × 234KB = 1.17MB 无意义重复
- 每次版本检查/模型刷新要独立触发

**改进**：应放入共享目录或用 symlink 指向统一位置

---

### 缺陷 4：沙箱 SID 可能冲突（中等，Windows 特有）

**证据**：T1 分析 `cap_sid` 内容

```json
{
  "workspace": "S-1-5-21-...",
  "readonly": "S-1-5-21-...",
  "workspace_by_cwd": { "c:/users/xuhao": "S-1-5-21-..." }
}
```

**问题**：
- 每个 Codex 实例独立初始化沙箱，创建不同的 Windows SID
- `.sandbox-secrets/sandbox_users.json` 中的 CodexSandboxOffline/Online 用户
  是 **系统级** 用户，多个实例共用同名 Windows 用户但 SID 不同 → 可能导致权限冲突
- `.sandbox/setup_error.json` 已记录防火墙规则创建失败，说明多实例场景下有竞争

**影响**：并发运行多个 Codex 实例时可能出现沙箱权限异常

---

### 缺陷 5：会话历史无跨账号共享能力（设计缺失）

**对比**：
- CCS Claude：deeper continuity mode 可共享 session-env、file-history、shell-snapshots、todos
- Codex：sessions/ 和 history.jsonl 始终独立，无共享选项

**影响**：
- 同一 context group 内的 Claude 账号可以看到彼此的项目上下文和会话历史
- 但同组的 Codex 账号之间完全隔离，无法接力工作
- 这打破了 CCS 多账号体系的一致性承诺

---

### 缺陷 6：从 ~/.codex 无自动迁移路径（体验问题）

**证据**：`runCodex.ts:438`

```typescript
const codexHomeDir = process.env.CODEX_HOME || join(os.homedir(), '.codex');
```

**问题**：
- 用户首次使用多账号功能前，所有数据在 `~/.codex`
- `!login` 创建新实例时不迁移 `~/.codex` 的数据
- 原始的 sessions/、history.jsonl、state_5.sqlite 等被"遗弃"
- 用户体验：切换到多账号后"丢失"所有历史会话

---

### 缺陷 7：context_group 在 Codex 端仅为元数据（逻辑断裂）

**证据**：`registerProfile()` (L296-328) 将 context_group 写入 config.yaml

```typescript
config.accounts[profileName] = {
    context_mode: contextMode,
    ...(contextGroup ? { context_group: contextGroup } : {}),
    continuity_mode: existing?.continuity_mode ?? 'standard',
};
```

**但**：Codex 端没有任何代码读取 context_group 来创建共享目录链接。这个字段对 Codex 来说是**死数据**。

`authCommand.ts` 中的 `isSharedContext()` 检查用于决定切换时是否需要重启会话，但 Codex 端实际上不存在任何共享数据，所以即使判定为"同组"也没有实质意义。

---

## 三、缺陷优先级矩阵

| # | 缺陷 | 严重度 | 影响面 | 修复复杂度 | 建议优先级 |
|---|------|--------|--------|-----------|----------|
| 1 | shared mode 形同虚设 | 🔴 严重 | 所有 shared mode 用户 | 中（参考 Claude 端实现） | P0 |
| 2 | 配置一次性复制 | 🟡 中等 | 多 profile 用户 | 低（改 copy 为 symlink） | P1 |
| 5 | 会话历史无共享能力 | 🟡 中等 | deeper continuity 用户 | 高（需设计 Codex sessions 共享） | P1 |
| 7 | context_group 死数据 | 🟡 中等 | 逻辑一致性 | 低（随 #1 一起修复） | P1 |
| 4 | 沙箱 SID 冲突 | 🟡 中等 | Windows 多实例并发 | 高（需理解 Codex 沙箱机制） | P2 |
| 6 | 无 ~/.codex 迁移 | 🟢 低 | 新用户首次使用 | 低（添加迁移逻辑） | P2 |
| 3 | models_cache 重复 | 🟢 低 | 磁盘空间 | 低（symlink） | P3 |

---

## 四、根因分析

**根本原因**：happy-cli 的 Codex 多账号支持是**后加的功能**，以 Claude 端的 CCS 架构为参考，但只实现了"认证隔离"这一层（CODEX_HOME 切换 + auth.json 隔离），而**没有移植 CCS 的共享层**（SharedManager 的 linkSharedDirectories/syncProjectContext/syncAdvancedContinuityArtifacts）。

CCS 的 SharedManager 只针对 Claude 实例目录（`~/.ccs/instances/`），不处理 Codex 实例目录（`~/.happy/codex-instances/`）。happy-cli 的 loginCommand.ts 中虽然定义了 `linkSharedDirectories()` 和 `syncProjectContext()` 函数，但 `performCodexLogin()` **没有调用它们**。

这不是一个 bug，而是一个**功能缺失** — shared mode 的目录共享逻辑只为 Claude 实现了，Codex 端还停留在"注册元数据"阶段。

---

## 五、修复建议

### Phase 1：让 shared mode 名副其实（P0）

在 `performCodexLogin()` 的 `registerProfile()` 之后，增加：

```typescript
if (contextMode === 'shared') {
    // 1. Link skills/plugins/commands 到共享目录
    linkSharedDirectories(codexInstancePath);  // 需适配 Codex 目录结构
    // 2. 共享 projects 上下文
    syncProjectContext(codexInstancePath, contextMode, contextGroup);
}
```

**注意**：需要确认 Codex 的 `skills/` 和 `.tmp/plugins/` 与 CCS 的 `skills/` 和 `plugins/` 目录结构是否兼容。如果不兼容，需要为 Codex 定义独立的 sharedItems 列表。

### Phase 2：配置共享化（P1）

将 `config.toml` 和 `.env` 从一次性复制改为 symlink 到共享位置：

```
~/.happy/shared/
├── codex-config.toml
└── codex.env
```

### Phase 3：会话连续性（P1）

为 Codex 实现类似 `syncAdvancedContinuityArtifacts()` 的机制，将 `sessions/` 和 `history.jsonl` 在 deeper mode 下链接到共享目录。

### Phase 4：迁移和清理（P2）

- 首次多账号登录时，提示用户是否从 `~/.codex` 迁移现有数据
- 沙箱 SID 共享机制研究（可能需要 Codex 上游支持）
