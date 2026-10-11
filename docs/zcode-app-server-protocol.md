# ZCode app-server protocol — reverse-engineering notes

> 目标:让 ZCode 桌面版自带的 CLI(`node /Applications/ZCode.app/Contents/Resources/glm/zcode.cjs`)以 headless 方式被 Relay runner 驱动。
> 状态:**协议层已通 80%**,卡在 provider registry 注入。本文记录全部已知信息,欢迎接着挖。

## 现象

`zcode -p "hi"` 报错:

```
Error: Model creation failed
Cause: Error: Select a model before continuing   (CONFIGURATION_ERROR)
```

headless 每次新建会话,而模型选择是**会话级**状态(`session_entry` 表 `runtime/model_selection` 行),新会话没有。桌面端/TUI 有人机界面选模型,headless 没有 → turn 0 的 model_creation 阶段直接失败。

## 已摸通的协议(app-server --stdio)

启动:`zcode app-server --stdio`,newline-delimited JSON,**不是** JSON-RPC。

请求信封:`{"id":"r1","method":"...","params":{...}}`(`id` 可省,省了就不回包;响应 `{"id":"r1","result":...}` 或 `{"id":"r1","error":{...}}`)。

服务端主动通知:`{"method":"startup/storageState",...}`(启动噪音,忽略)。

方法清单(抓自 bundle):`session/create|send|setModel|setMode|setThoughtLevel|events|subscribe|read|messages|list|resume|fork|stop|close|compact|goal|debug|subagents|usage`、`provider/updateAccountConfig`、`workspace/*`。

### 完整流程(已验证到 send 被接受)

1. **反向请求(关键!)** `session/create` 过程中 server 会发来
   `{"id":"server-N","method":"session/requestRuntimePreferences","params":{"sessionId":"sess_...","scope":"runtime-materialization"|"user-execution"}}`
   客户端**必须**回答,否则 15s 超时 create 失败:
   `{"id":"server-N","result":{"nativeSearchEnhancementsEnabled":false}}`
   (两个 scope 的 result schema 都只要这个 boolean;**不接受** modelSelection 键)

2. `session/create` params:`{"workspace":{"workspacePath":"/abs/path","workspaceKey":"/abs/path"}}`
   返回 `result.session.sessionId`(sess_...)。

3. `session/setModel` params:`{"sessionId":"sess_...","model":{"providerId":"...","modelId":"..."}}`
   (zod schema:`Pu = {providerId, modelId, options?: {reasoningLevel?}}` strict)

4. `session/send` params:`{"sessionId":"sess_...","content":"..."}`(注意是 `content` 不是 `prompt`)→ `{accepted:true}`

### 卡点:setModel 报 "Provider Registry 中不存在 Model"

- CLI 的 provider registry 与桌面端**不同源**。桌面端用 `account:bigmodel-start-plan`(云端账号 provider);CLI 里注册表为空。
- 试过无效:改 `~/.zcode/v2/config.json`(CLI 根本不读它,桌面端才读;而且里面的 provider 被写过 `enabled:false` + `systemDisabledReason` 字段——疑似某个时刻设置被回写污染);新建 `~/.zcode/cli/config.json`;`provider/updateAccountConfig` 注入(返回 `received`,但 setModel 仍找不到)。
- `session/requestRuntimePreferences` 的 result 不接受模型字段。
- 下一步实验(按性价比):交互式跑一次 TUI,用 `/model` 选一个模型,然后 `ls -lt ~/.zcode | head` 看它写哪个文件——那就是 CLI 真正的配置/状态位置;把里面的 provider/model 结构抄给 headless 场景即可。也可能 `doctor --verbose` 或某个 env(如 `GLM_BINARY_PATH`)能带出 registry 内容。

## 其他情报

- 模型解析字符串格式:`providerId/modelId`,reasoning level 用 `$` 分隔(`vz`/`gV` 函数,`QEe="$"`)。
- `--resume <sess_...>` 不会把已存会话的 model_selection 带进新 turn(实测仍报同样错误)。
- 会话存储:`~/.zcode/cli/db/db.sqlite`(表:session、session_entry、message、local_setting…;`session_entry.type='runtime/model_selection'`)。
- 反编译入口:bundle 里直接 grep `"Select a model before continuing"` / `sessionSetModel` / `requestRuntimePreferences`。
- 桌面端 spawn CLI 的参数:`app-server --stdio`,nativeConfigDir `.zcode/cli`,nativeConfigFileName `config.json`(native binary 场景;cjs CLI 的读取路径待确认)。

——Relay 项目调查,2026-10-11。探针脚本模式见 repo 历史中的 /tmp/probe*.mjs(create→答 prefs→setModel→send)。
