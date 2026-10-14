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

1. **回程 UX 未定义**:主线合并后怎么回到本地/GitHub 是手动的(bootstrap 拿 token → fetch → ff)。
   应做成 `relay-runner sync --repo fx-armory`(甚至监听 merged 事件自动推 GitHub)。
2. **约定文件名假设**:runner prompt 写死"阅读 AGENTS.md",fx-armory 实际是 CLAUDE.md
   (claude 自己变通了)。prompt 应探测存在的约定文件(AGENTS.md / CLAUDE.md / .cursorrules)。
3. **网络姿势**:workers.dev 被墙,runner 要带 `NODE_USE_ENV_PROXY=1` + 代理变量三件套,
   每次手敲容易忘(已写进 README;后续考虑 runner 自动探测本地代理)。
4. **审查上下文**:claude 的执行说明很有信息量(为什么放文件末尾、-type f 的理由),
   但这些只打在 runner 日志里,看板/溯源看不到——执行摘要或许值得进 git notes。
