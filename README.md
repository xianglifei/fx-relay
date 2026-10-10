# Relay

> 一个给 AI agent 用的 Git 协作内核 — 隔离、调度、溯源。
> A Git collaboration kernel for AI agents, built on Cloudflare Workers + Artifacts.

**状态:Day 1 施工中。** 完整的设计文档与演示视频将在发布时补齐。

## 核心原则

1. **隔离优先** — 每个任务 fork 一个独立工作区仓库,不做共享分支队列。
2. **冲突是调度问题** — 平台按 touch-set 调度合并:不相交的并行快进,相交的自动 re-fork 到新基线交回 agent 重做。对 agent,重做比三方合并便宜。
3. **仓库即记忆** — prompt、模型、任务引用作为 git notes 随 commit 持久,任何 agent 可接续任何任务。
4. **溯源第一** — 每行代码可追问:哪个 agent、哪个模型、受哪条规格指令。

## 组成

- `kernel/` — 控制面 Worker:任务 API、fork-per-task、合并调度、审查 agent(Workers AI)、溯源索引(D1)。
- `runner/` — 执行面 CLI:领任务、驱动本地真实 coding agent(zcode/claude/codebuddy/dsh 适配器)、commit + notes + push。
- `baseline-template/` — 演示基线应用。

## License

MIT
