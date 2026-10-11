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
  │  POST /tasks
  ▼
kernel fork 工作区仓库 + 签发 45min write token     ← 隔离
  │  GET /tasks?status=claimable + POST /tasks/:id/claim
  ▼
runner 认领,clone 工作区,驱动真实 coding agent    ← 执行
  │  (claude / codebuddy / … ,适配器插件式)
  ▼
agent 写码 commit;runner 挂 git notes 溯源,push    ← 溯源
  │  POST /tasks/:id/report (diff + touch_set)
  ▼
审查 agent(Workers AI)对照规格出结构化判定        ← 审查
  │  approve → awaiting_merge        reject → review_failed
  │                                  └→ 整改指令进入下一轮 prompt(可换厂商接手)
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
│   ├── src/index.ts   任务 API · fork · 审查 agent · 合并调度器 · 队列消费者
│   ├── src/dashboard.ts  内置看板(任务板 / 活动流 / 溯源)
│   └── schema.sql     D1 表结构(调度状态)
├── runner/            执行面 CLI
│   ├── bin/relay-runner.mjs   work | merge | seed | config
│   └── adapters.mjs   agent 适配器(插件式)
├── baseline-template/ 演示基线应用(中文 Todo,纯静态)
└── docs/              设计笔记
```

## Quickstart

前置:Node 20+,一个开了 Artifacts 的 Cloudflare 账号(Workers Paid),wrangler 4.149+。

```bash
# 1. 部署控制面
cd kernel
npm install
npx wrangler d1 create relay-kernel     # 把 database_id 填进 wrangler.jsonc
npx wrangler d1 execute relay-kernel --remote --file schema.sql
openssl rand -hex 24 | npx wrangler secret put RELAY_TOKEN
npx wrangler deploy                      # → https://<your>.workers.dev

# 2. 配置 runner(本地跑真实 agent)
cd ../runner
node bin/relay-runner.mjs config https://<your>.workers.dev <RELAY_TOKEN>

# 3. 种入基线仓库
node bin/relay-runner.mjs seed --dir ../baseline-template --repo demo-app

# 4. 提交一个任务,让 agent 干活
curl -X POST https://<your>.workers.dev/tasks \
  -H "Authorization: Bearer <RELAY_TOKEN>" -H "Content-Type: application/json" \
  -d '{"spec":"给应用加一个深色模式切换按钮"}'
node bin/relay-runner.mjs work --agent claude --once    # 或 codebuddy

# 5. 审查 + 合并
curl -X POST https://<your>.workers.dev/schedule -H "Authorization: Bearer <RELAY_TOKEN>"
node bin/relay-runner.mjs merge --once

# 看板:https://<your>.workers.dev/
```

## Agent 适配器

| adapter | 状态 | 说明 |
|---|---|---|
| claude | ✅ 实测 | `claude -p`,遵守 AGENTS.md 项目约定 |
| codebuddy | ✅ 实测 | `codebuddy -p --dangerously-skip-permissions` |
| zcode | 🔧 协议已通 | app-server 协议逆向笔记见 [docs/zcode-app-server-protocol.md](docs/zcode-app-server-protocol.md),待 provider registry 注入 |
| 你的 agent | 欢迎 PR | 任何有 headless 模式的 CLI,往 `adapters.mjs` 加一段即可 |

## 设计笔记

- **时间规则保证收敛**:调度器的冲突判断只比较"本任务 fork **之后**合并进主线的任务"。若用 sha 相等判断,链式合并会造成无限 re-fork(我们踩过);时间规则在构造上收敛。
- **touch-set 是申报制**:runner 从 `git diff --name-only fork_base..HEAD` 计算,是乐观估计;git 层面 cherry-pick 是最终裁决。调度器宁可错杀(多一次重做),不放过大 diff。
- **调度器一次只发一个合并令牌**:主线线性是硬约束,合并天然串行;吞吐靠"重做便宜"来兜底,不靠并行合并。
- **kernel 不跑 git**:Workers 里没有 git 二进制。快进/重放由本地 runner 执行,平台持有"决定权",机器持有"执行权"。

## 路线图

- [ ] 审查策略可配置(现在写死在 kernel,AGENTS.md 约定应进审查 prompt)
- [ ] 事件订阅替代轮询(Artifacts push 事件 → Queues 已接,语义闭环待打磨)
- [ ] 预览部署(每任务一个 Workers 预览环境)
- [ ] 合并队列可视化(看板展示调度决策原因)
- [ ] zcode 适配器补完

## License

MIT
