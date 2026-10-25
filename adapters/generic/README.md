# @agent-flow/adapter-generic

兜底适配器：**任何**会往文件里追加 JSONL 日志的 agent 客户端都能接入 AgentFlow。

## 约定

被监视目录下的 `*.jsonl` 文件，每行一个 JSON 对象，是「准 AgentEvent」：

- 必填：`title`（人话标题）、`phase`（`user_prompt` / `plan` / `tool_start` / `tool_end` / `turn_end` / `note`）
- 选填：`sessionId`（缺省=文件名）、`id`（缺省自动生成）、`ts`（缺省=当前时间）、
  `tool`、`files`、`input`、`output`、`planItems`、`status`
- `adapter` 强制为 `generic`；非法行直接跳过

## 最小示例

让你的 agent 工具往 `~/.my-agent/logs/session-a.jsonl` 追加：

```json
{"phase":"user_prompt","title":"用户：帮我修个 bug"}
{"phase":"tool_start","tool":"Read","title":"读取 main.py","files":["main.py"]}
{"phase":"tool_end","tool":"Read","title":"读取 main.py","status":"ok"}
{"phase":"turn_end","title":"完成"}
```

然后 `startGenericWatcher({ dir: '~/.my-agent/logs' })`（由 `agent-flow start` 统一拉起），
它的每一步就会实时出现在 AgentFlow 面板上。
