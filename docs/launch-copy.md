# 发布文案(备用)

## Show HN 标题

Show HN: Relay – a Git collaboration kernel for AI agents (Cloudflare Workers + Artifacts)

## Show HN 正文

Hi HN! We built Relay, a Git collaboration kernel designed for AI agents instead of humans, running on Cloudflare Workers + Artifacts.

GitHub's primitives — shared repo, branches, pull requests — encode human economics: scarce attention, social trust, one task at a time. Agents have the opposite economics: attention is nearly free, context is expensive and ephemeral, concurrency is the default, and trust has to be auditable rather than social.

Relay's answer, built on Artifacts' repo-per-workspace model:

1. **Fork-per-task.** Every task gets a fresh repo forked from the baseline plus a 45-minute repo-scoped write token. No shared branch queues.

2. **Merge scheduling instead of merge conflicts.** Each runner reports a touch-set (files changed). The scheduler keeps mainline strictly linear: fast-forward when possible, cherry-pick replay when files are disjoint, and — the interesting case — when touch-sets overlap, it automatically re-forks the task onto the new baseline and hands it back to the agent to redo. For an agent, redoing on a fresh baseline is cheaper and safer than resolving a three-way merge, because its context lives in the repo (git notes), not in a dying session.

3. **The repo is the memory.** Task spec, review verdicts, remediation instructions and run metadata all travel as git notes on commits. Any agent — including one from a different vendor — can pick up where the last one died.

4. **Provenance first.** Every commit on mainline can answer: which agent, which model, under which task spec, what the reviewer said, how many attempts.

A review agent (Workers AI) gates every push with a structured verdict; its remediation instructions become the next round's prompt. In our demo, a task was deliberately failed by one agent, rejected by the reviewer, picked up and completed by a *different vendor's* agent — using only what the repo remembered.

Stack: one Worker (task API, fork/token minting, scheduler, review agent, D1 for scheduling state), a local runner CLI that drives real coding CLIs headless (Claude Code and CodeBuddy work today; ZCode's app-server protocol is 80% mapped), and a built-in dashboard. Artifacts speaks Git over HTTPS, so everything stays plain git under the hood.

What we learned building it: the scheduler's conflict rule must be *temporal* (only tasks merged after your fork can conflict with you) — comparing SHAs causes infinite re-fork loops. And mainline-linear is a feature: merges serialize through one token, throughput comes from cheap redos, not parallel merges.

Repo: https://github.com/xianglifei/fx-relay (MIT). Kernel deploys in ~10 minutes; the runner drives your own locally-installed agents.

Happy to answer anything — especially curious how others are handling concurrent-agent collision on shared files.

## V2EX 标题

Relay:给 AI agent 用的 Git 协作内核(开源,Cloudflare Workers + Artifacts)/ 多 agent 并发写码,冲突自动重做

## V2EX 正文

做了个开源项目 Relay,解决一个最近折磨我的问题:同时放几个 coding agent 出去干活,它们就会在同一个仓库里打架——分支互相盖、冲突没法看、谁改了什么都说不清。

GitHub 这套"仓库+分支+PR"是围绕人设计的。Agent 的经济学不一样:注意力近乎免费、上下文昂贵易失、并发是常态、信任必须可审计。所以 Relay 没有做"GitHub 加个机器人",而是把协作内核重写了一遍,跑在 Cloudflare Workers + Artifacts 上:

1. **每个任务 fork 一个独立仓库**,签发 45 分钟的仓库级 write token,没有共享分支;
2. **冲突是调度问题**:runner 上报 touch-set(改了哪些文件),调度器保证主线严格线性——没冲突就快进/重放,**touch-set 相交就自动 re-fork 到新基线,把任务丢回给 agent 重做**。对 agent 来说重做比解冲突便宜,因为它的上下文(git notes)都在仓库里;
3. **仓库即记忆**:任务规格、审查判定、整改指令全部挂在 git notes 上随 commit 持久。实测一个任务被审查 agent 打回后,换成另一家厂商的 agent 凭仓库记忆接手完成;
4. **审查 agent**(Workers AI)给每次 push 出结构化判定,不通过就带着机器可执行的整改指令回到队列;
5. 内置看板:任务板 / 活动流 / 溯源(每个 commit 可追问"哪个 agent、哪个模型、受哪条规格写的")。

演示主线现在有 8 个线性 commit:紫色主题、胶囊按钮、页脚、筛选栏(人故意做残→打回→CodeBuddy 接手)、计数徽章、字数统计——由 Claude Code 和 CodeBuddy 两家 agent 在 4 天里接力完成,期间发生 1 次审查打回、2 次自动 re-fork 重做,主线从未分叉。

代码:https://github.com/xianglifei/fx-relay(MIT,kernel 十分钟能部署,runner 驱动你本地已装的任何 headless coding CLI)

欢迎拍砖,尤其想听听大家在"多 agent 并发改同一批文件"上的实践。

## 推文(Twitter/X)

Built a Git collaboration kernel for AI agents: fork-per-task, merge scheduling instead of merge conflicts (overlapping touch-sets → auto re-fork → agent redoes on new baseline), provenance as git notes. Two vendor agents relayed one task through a review rejection. Mainline never diverged. MIT: github.com/xianglifei/fx-relay
