# @agent-flow/adapter-workbuddy

接入 WorkBuddy（Electron 版 AI 工作台）。无需 WorkBuddy 任何配合——三个**本机只读数据源**
的 watcher，`agent-flow start` 检测到 `~/.workbuddy` 存在时自动启动：

| 数据源 | 形态 | 映射 |
|---|---|---|
| `audit-log/<YYYY-MM-DD>.jsonl` | 追加式审计日志（哈希链） | 沙箱命令 → `Bash` 工具节点；文件读取放行 → `Read`；等待授权 / 敏感信息 → 说明节点 |
| `changes-index/<sessionId>.json` | 整文件重写 | 变更条目 → `Write`（新建）/ `Edit`（修改）/ `Bash`（删除），带文件路径与时间戳 |
| `<profile>/sidebar-list-snapshot.json` | 整文件重写 | 会话标题 → 合成 `user_prompt`；任务转空闲 → `turn_end`（面板正确显示「已结束」） |

## 诚实声明

- WorkBuddy 的对话正文存于 SQLite（`workbuddy.db`，运行中被应用锁定），零依赖 adapter 不碰它。
  因此**拿不到用户提问原文与 AI 计划**：user_prompt 用侧栏标题合成（`input.source` 标注
  `workbuddy-session-title`，如实说明来源），没有 plan 分组，why 只有工具入参一种来源。
- 事件 id 取自数据源自带标识（审计记录 uuid / `change.id`），watcher 重启重读不会重复入库。
- 字段基于 2026-10 实测的 WorkBuddy v1.x 审计格式（`schemaVersion: 2`）；上游改格式只需调整
  `src/mapper.ts` 一个文件。
