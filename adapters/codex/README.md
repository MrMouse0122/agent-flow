# @agent-flow/adapter-codex

接入 OpenAI Codex CLI，两条腿互补：

1. **notify 回调**（粗粒度）：在 `~/.codex/config.toml` 加一行指向本包 `notify.cjs`：

   ```toml
   notify = ["node", "<绝对路径>/adapters/codex/notify.cjs"]
   ```

   每轮完成时收到 `turn_end` 事件。

2. **会话日志 watcher**（细粒度）：`startCodexWatcher()` 监视 `~/.codex/sessions/**/*.jsonl`，
   增量解析每一行，识别用户消息 / 工具调用 / 轮次结束，翻译成 AgentEvent 发给 server。

## 已知对齐点（诚实声明）

`mapCodexLine` 的行格式识别（`type` / `role` / `name` / `arguments` 等字段）基于公开样例的
**假设实现**。接入真实 `~/.codex/sessions` 后如果识别率不对，只需要调整 `src/watcher.ts`
里的 `mapCodexLine` 一个函数——增量读取、去重、上报机制都不用动。
