# @agent-flow/adapter-ds-harness

接入 DeepSeek Harness（dsh，`@deepseek-ai/dsh`）。dsh 是「一切皆插件」的框架
（模型/工具/会话/循环/UI 都是 Cordis 插件），因此本 adapter 按**官方姿势**做成
telemetry 插件：订阅会话事件总线，把持久事实流翻译成 AgentEvent POST 给 AgentFlow。

## dsh 侧会话事件 → 面板节点

dsh 的会话是事件溯源日志，信封 `{ seq, time, type, data }`。映射规则（`plugin/mapper.js`）：

| dsh 事件 | AgentEvent | 说明 |
|---|---|---|
| `user/message` | `user_prompt` | 用户提问原文 |
| `assistant/message` | `note` | AI 的阶段性输出 |
| `tool/call` | `tool_start` | raw arguments 是 JSON 字符串，会解析并提取 command/file_path |
| `tool/result` | `tool_end` | error/isError → 失败着色 |
| `todo/write` | `plan` | todo 列表 → 计划分组节点 |
| `turn/end` | `turn_end` | kind 为 error/blocked/aborted → 失败 |
| `turn/start`、`step/*` | 忽略 | 过程信号不造节点 |

事件 id = `dsh:<sessionId>:<seq>`，seq 单调递增，天然幂等去重。

## 挂载

```bash
# 方式一：按 npm 包安装（本包 package.json 已声明 dsh.bundle）
dsh plugin --profile <你的profile> add <agent-flow 仓库>/adapters/ds-harness

# 方式二：--patch 一次性挂载
dsh --profile web --patch <agent-flow 仓库>/adapters/ds-harness/cordis.patch.yml
```

server 侧无需配置：`agent-flow start` 运行即可接收（插件对 server 不在线有容忍，
事件会丢但不影响 dsh 会话本身）。

## 诚实声明

- dsh 处于 Developer Preview（0.1.0-rc.x），**本 adapter 未能在本机端到端验证**
  （这台机器没有安装 dsh）。映射字段名以官方文档与社区教程为参照，并对常用别名
  做了兼容；接入真实环境若字段对不上，**只需调整 `plugin/mapper.js` 一个文件**，
  订阅与上报逻辑不用动。
- 订阅走 `ctx.on('session/event')`（UI 层复现会话用的同一事件源）；载荷形状按
  `{ sessionId, event }` / 事件本体两种形态做了兼容提取。
- 没有插件能力的老版本 dsh，退路是让会话日志落到某目录后走 generic adapter：
  `agent-flow start --watch <日志目录>`（信息有损，面板如实标注）。
