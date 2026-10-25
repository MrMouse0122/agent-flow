# @agent-flow/adapter-codex

接入 OpenAI Codex CLI，两条腿互补：

1. **notify 回调**（粗粒度）：在 `~/.codex/config.toml` 加一行指向本包 `notify.cjs`：

   ```toml
   notify = ["node", "<绝对路径>/adapters/codex/notify.cjs"]
   ```

   每轮完成时收到 `turn_end` 事件。

2. **会话日志 watcher**（细粒度）：`startCodexWatcher()` 监视 `~/.codex/sessions` 下
   按日期嵌套的 `.jsonl`，增量解析每一行，翻译成 AgentEvent 发给 server。

## 行格式（对齐 openai/codex 真实 rollout）

真实 rollout 行是三层信封 `{"timestamp":"…","type":"…","payload":{…}}`，事件主体在
`payload` 里，按 payload.type 白名单分发：

| payload.type | 事件 |
|---|---|
| `user_message`（event_msg） | `user_prompt` |
| `agent_message`（event_msg） | `note` |
| `task_complete` / `turn_completed`（event_msg） | `turn_end` |
| `session_meta`（type 在信封层） | `note`（会话开始） |
| `message`（response_item，按 role 分流） | `user_prompt` / `note` |
| `function_call`（response_item） | `tool_end`（arguments 是 JSON 字符串，command 数组会拼成一行） |
| `reasoning` / `function_call_output` / 其他 | 忽略（不凭空造节点） |

行内 `timestamp`（ISO）解析为事件 ts；顶层扁平的旧格式（`role`/`name`/`type` 直接字段）
保持兼容。上游改格式时只需要调整 `src/watcher.ts` 里的 `mapRolloutPayload` / `mapCodexLine`
两个函数——增量读取、去重、上报机制都不用动。
