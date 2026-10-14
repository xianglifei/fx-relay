# AGENTS.md — 给来访 coding agent 的操作手册

Relay 是一个跑在 Cloudflare Workers + Artifacts 上的「给 AI agent 用的 Git 协作内核」。
本文件告诉你(来访 agent)这个仓库的结构、怎么验证改动、哪些事不能做。人类视角的完整文档见 [README.md](README.md)。

## 仓库结构

```
kernel/    控制面 Worker(TypeScript, wrangler 部署)
           src/logic.ts 是纯函数层(无 IO),所有可单测的决策逻辑在这里
           src/index.ts 是路由 + D1/Artifacts/Workers AI 绑定
           src/dashboard.ts 是单文件看板(无构建步骤)
           schema.sql 全量表结构;migrate<N>.sql 是已有部署的增量(两者要保持一致)
runner/    执行面 CLI(零依赖 node:ESM)
           bin/relay-runner.mjs: task|attach|sync|seed|work|merge|config
           adapters.mjs: coding agent 适配器(插件式)
           lib/: 可单测的纯 helper
deploy/    常驻工件(launchd plist + systemd unit)
docs/      设计笔记、演示视频、协议逆向笔记
DOGFOOD.md 日常使用日志——摩擦清单决定后续优先级
```

## 改动必须过的门

```bash
# 1. 类型(必须零错误)
cd kernel && npx wrangler types && npx tsc --noEmit

# 2. 单测(kernel 纯逻辑 + runner helpers)
cd .. && node --test kernel/test/logic.test.ts runner/test/*.test.mjs

# 3. 集成(需要已部署的 kernel;先停本机常驻 merge 服务,跑完恢复)
launchctl bootout gui/$(id -u)/com.relay.merge   # 或 systemctl stop relay-merge
cd kernel && node --use-env-proxy test/integration.mjs   # 需 HTTPS_PROXY 指向本地代理
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.relay.merge
```

CI(GitHub Actions)只跑 1 和 2;3 需要真实 Cloudflare 资源,本地跑。

## 约定

- **状态机在 schema.sql 的注释里**,改动 task 状态流转时必须同步那幅图和集成测试。
- **kernel 不跑 git**(Workers 无 git 二进制):决策在 kernel,git 操作在 runner。
- **审查 fail-closed**:AI 审查失败挂起(needs_human),绝不自动放行。确定性闸门(策略/本地检查)在 logic.ts,是纯函数。
- **提交信息格式**:`relay: <一句话>` 起头,正文列要点。一个主题一个提交。
- **机密绝不入库**:token 只存 `runner/relay.local.json`(已 gitignore,600 权限)或 wrangler secret。

## D1 迁移

改表结构 = 改 schema.sql + 新增 migrate<N>.sql + 远端执行:

```bash
cd kernel && npx wrangler d1 execute relay-kernel --remote --file migrate<N>.sql -y
```

## 部署

```bash
cd kernel && npx wrangler deploy    # 生产: https://relay-kernel.xianglifei.workers.dev
```

部署后看板即刻生效(单文件 HTML 随 Worker 分发)。
