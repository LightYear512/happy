# Codex 索引检查按钮

在 Happy App 的**控制台**打开主菜单（`@@`），点“检查并修复 Codex 索引”，再选择账号。也可以发送 `!index <账号名>`。此操作不会切换全局账号。

- 当前版本的索引已完成且检查通过：直接显示正常，不调用模型。
- 索引缺失或回填中断：账号空闲时，复用同一共享历史且数据库迁移及 checksum 相同的原生完成索引，建立独立数据库。原有线程及账号专属数据不能丢失。
- 没有合格源库：备份原库，由当前 Codex 原生初始化；最长 30 分钟，可用按钮或 `!cancel` 取消。不能把“仍在回填”强行改为成功。
- 账号正在使用、数据库被占用或无法确认空闲：保留现状并说明原因，不终止用户会话。
- 修复后进行原生初始化、认证和一条真实模型回复验证。此测试会产生少量用量；额度不足、认证失效或网络超时分别显示，不能视为聊天已恢复。

取消会停止本次 Codex 测试进程；已经开始的短索引安装先安全完成。原始备份保存在 Happy 数据目录的 `incidents/index-*`，临时文件在独立 `xc-disposable/happy-index-*` 目录。

当前自动修复支持装有 `ps`、`lsof` 的 macOS/Linux 主机，Node.js 需提供 `node:sqlite.backup`（22.16 或更新版本）。按钮由 CLI 通过现有 options 协议下发，App/Server 不需要新增接口。CLI 源码或构建更新后，已运行的控制台不会自动重载；部署和启用情况必须单独确认。

验证：

```sh
node --test scripts/__tests__/codex-index.test.mjs
HAPPY_SKIP_TEST_BUILD=1 npx vitest run src/commands/bang/dispatcher.test.ts
yarn typecheck
```
