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

- [x] attach fx-armory（真实仓库、带历史、工作区不被动）→ 首个基线
- [ ] 首任务全周期：README 加「技能自检」一节
- 观察：无 package.json 的仓库确定性检查自动跳过（无事可判）；
  后续观察有测试的仓库上 npm ci 耗时是否可接受

### 别扭清单（发现即记，决策时用）

- （空）
