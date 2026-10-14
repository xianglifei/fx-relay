# Relay

**A Git collaboration kernel for AI agents.**
**给 AI agent 用的 Git 协作内核。**

Relay runs on Cloudflare Workers + [Artifacts](https://developers.cloudflare.com/artifacts/) and reimplements how changes are made to a codebase when the primary committers are AI agents — not humans.

> 传统 GitHub 的原语是"仓库 + 分支 + PR",围绕人类的注意力与信任设计。
> Relay 的原语是 **fork-per-task、合并调度、溯源**:围绕 agent 的经济学设计——
> 注意力近乎免费,上下文昂贵易失,并发极高,信任必须可审计。

## 设计原则

1. **隔离优先(Isolation first)** — 每个任务 fork 一个独立工作区仓库,签发短时仓库级 write token。没有共享分支队列,没有大 diff 热点。Cloudflare Artifacts 的最佳实践:"如果你有一万个 agent,就开一万个仓库。"
2. **冲突是调度问题,不是代码问题(Conflict is a scheduling problem)** — 平台按任务的 touch-set(改了哪些文件)调度合并:主线没动 → 快进;动了但文件不相交 → 重放(cherry-pick);**相交 → 自动 re-fork 到新基线,把任务交回 agent 重做**。对 agent,"在最新基线上重做"比"解三方合并"便宜——上下文都在,重做是机械的。
3. **仓库即记忆(The repo is the memory)** — agent 会话之间无状态。任务规格、审查判定、整改指令、执行元数据全部作为 git notes 随 commit 持久,任何(可能是另一厂商的)agent 都能从仓库接续工作。
4. **溯源第一(Provenance first)** — 每个合并进主线的 commit 都能回答:哪个 agent、哪个模型、受哪条任务规格、审查说了什么、重做了几轮。

## 一个任务的一生

```
任务规格(spec)
  │  POST /tasks  (submit token 即可)
  ▼
kernel fork 工作区仓库 + 签发 45min write token     ← 隔离
  │  GET /tasks?status=claimable + POST /tasks/:id/claim
  ▼
runner 认领,clone 工作区,驱动真实 coding agent    ← 执行
  │  (claude / codebuddy / … ,适配器插件式)
  ▼
agent 写码 commit;runner 挂 git notes 溯源,push    ← 溯源
  │  随后按 fork 基线脚本跑 npm test / lint(确定性闸门)
  │  POST /tasks/:id/report (diff + touch_set + checks)
  ▼
四道闸门:策略 → 本地检查 → AI 审查 → (可选)人审    ← 信任
  │  approve → awaiting_merge        reject → review_failed(整改指令进下一轮)
  │  AI 失败/解析失败/人审标记 → needs_human(看板放行或打回)
  ▼
合并调度器:touch-set 与主线冲突吗?                 ← 调度
  ├─ 主线未动              → fast-forward
  ├─ 动过但文件不相交       → cherry-pick 重放
  └─ 相交                  → 自动 re-fork,agent 在新基线重做
  ▼
mainline 永远线性;每个 commit 可追问出处
```

## 组成

```
fx-relay/
├── kernel/            控制面 Worker(本仓库可直接部署)
│   ├── src/index.ts   任务 API · fork · 四道闸门 · 合并调度器 · 队列消费者
│   ├── src/logic.ts   纯逻辑:调度决策 · glob 策略 · 检查评估(单测覆盖)
│   ├── src/dashboard.ts  内置看板(任务板 / 活动流 / 溯源 / 人审按钮)
│   └── schema.sql     D1 表结构(调度状态;migrate2-4 为增量)
├── runner/            执行面 CLI
│   ├── bin/relay-runner.mjs   task | attach | seed | work | merge | config
│   └── adapters.mjs   agent 适配器(插件式)
├── deploy/            常驻工件:launchd plist(macOS) + systemd unit(Linux)
├── baseline-template/ 演示基线应用(中文 Todo,纯静态)
├── DOGFOOD.md         日常使用日志(真实仓库两周试用,发现即记)
└── docs/              设计笔记
```

## Quickstart

前置:Node 20+(常驻建议 24+),一个开了 Artifacts 的 Cloudflare 账号(Workers Paid),wrangler 4.149+。
国内网络注意:`*.workers.dev` 通常不可直连,给 runner 配代理(`NODE_USE_ENV_PROXY=1` + `https_proxy=http://127.0.0.1:7897`)。

```bash
# 1. 部署控制面
cd kernel
npm install
npx wrangler d1 create relay-kernel     # 把 database_id 填进 wrangler.jsonc
npx wrangler d1 execute relay-kernel --remote --file schema.sql
openssl rand -hex 24 | npx wrangler secret put RELAY_TOKEN        # admin 令牌
openssl rand -hex 24 | npx wrangler secret put RELAY_SUBMIT_TOKEN # 可选:只提交令牌(见「令牌分级」)
npx wrangler deploy                      # → https://<your>.workers.dev

# 2. 配置 runner
cd ../runner
node bin/relay-runner.mjs config https://<your>.workers.dev <RELAY_TOKEN>

# 3. 把你已有的仓库接进来(日常使用的主入口;只推已提交历史,不动源工作区)
node bin/relay-runner.mjs attach --dir /path/to/your-repo --repo your-repo

# 4. 提交一个任务(一行;--allow 收窄文件范围,--needs-human 加人工闸门,--file 从 markdown 读规格)
node bin/relay-runner.mjs task "给应用加一个深色模式切换按钮" \
  --baseline your-repo --allow "src/**,styles/**"

# 5. 让 agent 干活 + 合并(手动单次,或装成常驻服务,见「常驻 runner」)
node bin/relay-runner.mjs work --agent claude --once
node bin/relay-runner.mjs merge --once     # merge 循环自带 /schedule,常驻即无人值守

# 看板:https://<your>.workers.dev/  (admin 令牌进看板,needs_human 任务可一键放行/打回)
```

## 信任模型:三道闸门 + 一道人闸

日常使用的前提是"敢把真项目托付给它",所以审查是四层的,自下而上先机械后语义:

1. **策略闸门(kernel,确定性)** — 任务可带 `policy`:`allow`/`deny` glob、`max_files`、`max_diff_bytes`。
   内置禁改清单(`.env*`、`*.pem`、`id_rsa*`、`.github/workflows/**` 等)永远生效,deny 胜过 allow。
   命中即拒,拒绝理由与整改指令是机器生成的,不经过任何模型。
2. **本地检查闸门(runner,确定性)** — push 后、报告前,runner 按 **fork 基线**的 `package.json`
   跑 `npm test` / `npm run lint`(脚本从基线读,agent 删掉测试脚本也逃不掉;依赖 `npm ci` 装进工作副本)。
   非零退出码 → 确定性拒绝,输出 tail 进入整改指令。仓库无 package.json 或旧版 runner 时此闸门跳过(不误伤)。
3. **AI 审查闸门(Workers AI,语义)** — 对照规格出结构化判定。**fail-closed**:模型调用失败、输出不可解析
   → 任务挂起为 `needs_human`,绝不自动放行。
4. **人审闸门(可选)** — 任务带 `needs_human_review: true` 时,AI 批准也不直接进合并队列,
   挂起等人在看板一键放行/打回;打回备注即下一轮整改指令。

前两道闸门的判定是纯函数(`kernel/src/logic.ts`),有单测把守;确定性拒绝走的还是原来的
review_failed → claim(带指令)整改循环,不新增学习成本。

## 令牌分级

| 令牌 | 能做什么 | 给谁 |
|---|---|---|
| `RELAY_TOKEN`(admin) | 一切:调度、合并、认领、人审、bootstrap | 运维者 / runner 本体 |
| `RELAY_SUBMIT_TOKEN`(可选) | 提交任务 + 只读看板/列表;调度、认领、人审、合并一律 401 | 团队成员 |

不设 `RELAY_SUBMIT_TOKEN` 时行为与单令牌完全一致。fork 的 45min 仓库级 write token 机制不变。

## 常驻 runner(无人值守)

- **macOS(launchd)**:`deploy/com.relay.merge.plist` — 替换 `RUNNER_DIR` 与代理地址后
  `cp` 进 `~/Library/LaunchAgents/` 并 `launchctl load`,日志 `runner/relay-merge.log`。
- **Linux(systemd)**:`deploy/relay-merge.service` — 适用于可达 kernel 的服务器。境内服务器到
  `*.workers.dev` 通常不通(火山云 GZ/BJ 实测),需海外机、代理,或给 worker 绑自定义域。
- merge 循环**自带调度**(每轮先打 `/schedule`,幂等),装一个 merge 服务即是完整的无人值守合并路径;
  work 循环(驱动编码 agent)按需 `--once` 或同样常驻,注意 agent 配额消耗。daemon 模式出错退避 15s。

## Agent 适配器

| adapter | 状态 | 说明 |
|---|---|---|
| claude | ✅ 实测 | `claude -p`,遵守 AGENTS.md 项目约定 |
| codebuddy | ✅ 实测 | `codebuddy -p --dangerously-skip-permissions` |
| zcode | 🔧 协议已通 | app-server 协议逆向笔记见 [docs/zcode-app-server-protocol.md](docs/zcode-app-server-protocol.md),待 provider registry 注入 |
| 你的 agent | 欢迎 PR | 任何有 headless 模式的 CLI,往 `adapters.mjs` 加一段即可 |

## 测试

```bash
# 单元测试(纯逻辑:调度决策、touch-set 时间规则、glob 策略、检查评估、AI 输出解析、CLI 参数)
node --test kernel/test/logic.test.ts runner/test/flags.test.mjs

# 集成测试(专项:鉴权、校验、认领竞态、全生命周期、打回-整改闭环、策略闸门、
#            人审闸门、令牌分级、状态守卫、主线线性;独立测试基线,跑完自动清理)
node kernel/test/integration.mjs --url https://<your>.workers.dev --token <RELAY_TOKEN> \
  [--submit-token <RELAY_SUBMIT_TOKEN>]
```

集成套件 T8 断言测试主线 commit 数精确匹配——防止调度器把不相干变更放进主线,或静默丢合并。
T9/T10 验证确定性与人审路径不经 AI(策略闸门)或挂起后人可裁决。

## 设计笔记

- **时间规则保证收敛**:调度器的冲突判断只比较"本任务 fork **之后**合并进主线的任务"。若用 sha 相等判断,链式合并会造成无限 re-fork(我们踩过);时间规则在构造上收敛,并有回归单测把守(`REGRESSION: ... must NOT refork`)。
- **touch-set 是申报制**:runner 从 `git diff --name-only fork_base..HEAD` 计算,是乐观估计;git 层面 cherry-pick 是最终裁决。调度器宁可错杀(多一次重做),不放过大 diff。
- **调度器一次只发一个合并令牌**:主线线性是硬约束,合并天然串行;吞吐靠"重做便宜"来兜底,不靠并行合并。merger 崩溃会由 /schedule 的 stale 回收(10 分钟)自愈。
- **整改 diff 需要整改上下文**:审查 agent 若不知道"这是第 N 次尝试、上一轮为何被打回",会合法地拒绝一个 noisy 的修复 diff(它看到的是恢复性大改动)。审查 prompt 现在携带整改背景——这个坑是集成测试 T6 抓出来的。
- **kernel 不跑 git**:Workers 里没有 git 二进制。快进/重放由本地 runner 执行,平台持有"决定权",机器持有"执行权"。确定性闸门的脚本从 fork 基线读,同样是"决定权在平台侧、执行在机器侧"的体现——agent 改 HEAD 的 package.json 逃不掉基线的测试。
- **fail-closed 的边界**:AI 审查失败/解析失败挂起为人审,不再放行打标;确定性闸门(策略/本地检查)不受 prompt injection 影响。残留:AI 审查的 prompt 仍含规格与 diff,理论上可被 spec 内注入操纵——但它只能影响语义层判定,过不了策略与本地检查这两道机械闸门,且可用 `--needs-human` 对敏感任务强制人审。

## 路线图

- [x] 确定性信任层:任务级策略(allow/deny/max_files)+ 本地 test/lint 闸门 + fail-closed + 人审闸门
- [x] 令牌分级(submit/admin)+ 一行式任务提交 + attach 已有仓库
- [x] 常驻 merge(自调度,launchd/systemd 工件)
- [ ] AGENTS.md 项目约定进审查 prompt(策略已可任务级配置,约定级待做)
- [ ] 事件订阅替代轮询(Artifacts push 事件 → Queues 已接,语义闭环待打磨)
- [ ] worker 自定义域(境内服务器常驻 merge 的前置)
- [ ] 预览部署(每任务一个 Workers 预览环境)
- [ ] 合并队列可视化(看板展示调度决策原因)
- [ ] zcode 适配器补完

## License

MIT
