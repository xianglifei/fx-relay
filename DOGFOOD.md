# Relay Dogfood 日志

定位：个人/小团队、中小项目日常使用。从 2026-10-14 起用真实仓库（首批：fx-armory）当日常主力，
记录每一处别扭 —— 用使用日志代替分析来决定后续优先级。

## 环境

- kernel：https://relay-kernel.xianglifei.workers.dev（已部署确定性闸门版）
- 常驻 merge：本机 launchd `com.relay.merge`（日志 `runner/relay-merge.log`，走本地代理）
- 网络：workers.dev 被墙，runner 需 `NODE_USE_ENV_PROXY=1` + `https_proxy=127.0.0.1:7897`；
  火山云 GZ/BJ 均不可达（VPS 常驻方案待自定义域或海外机）
- token：admin 在 `runner/relay.local.json`；submit token 已生成（供只提交场景）

## 记录

### 2026-10-14 — 启动

- [x] attach fx-armory(真实仓库、带历史、工作区不被动)→ 首个基线
- [x] 首任务全周期 tsk_72294aa42b(README 加「⭐ 技能自检」节,`--allow README.md`):
  task 一行提交 → claude 19s 完成(实测技能数 35,与 README 声明一致)→ 审查 approve →
  常驻 launchd merge 自动调度合并(af557c4)→ 手动 fetch+ff 同步回本地。全程无人工干预点(合并侧)。
- 观察:无 package.json 的仓库确定性检查自动跳过(无事可判);
  后续观察有测试的仓库上 npm ci 耗时是否可接受

### 别扭清单(发现即记,决策时用)

1. ~~**回程 UX 未定义**~~ → ✅ 已修:`relay-runner sync --repo X --dir <本地> [--push]`,ff-only,E2E 验证(2026-10-14)。
2. ~~**约定文件名假设**~~ → ✅ 已修:prompt 自动探测 AGENTS.md/CLAUDE.md/GEMINI.md/.cursorrules,没有则退化为「遵循现有风格」。
3. ~~**网络姿势**~~ → ✅ 已修:runner 直连失败时自动探测本地代理(7897/7890/7891/1087/8118)并 re-exec;`RELAY_NO_PROXY=1` 禁用。
4. ~~**审查上下文**~~ → ✅ 已修:任务 prompt 要求 agent 在 stdout 收尾输出执行摘要,runner 取尾部 1200 字进 git notes(溯源)并在看板展示。

### 2026-10-14 晚 — P0/P1 收尾

- sync/约定探测/摘要进溯源/自动代理 全部上线并 E2E 验证;AGENTS.md、README 双语 + 演示视频 + 看板截图就位。
- 顺手清了 59 条测试残留任务与其工作区仓库(失败套件轮次的遗留),看板恢复干净。
