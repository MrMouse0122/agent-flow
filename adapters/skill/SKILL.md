---
name: agent-flow
description: Use at the start of any multi-step task (coding, debugging, research, refactoring) to check once whether the local AgentFlow visualization server (http://127.0.0.1:4765) is running; if it is, report each meaningful step of your work as a structured event so the human can watch the task progress live. If the server is down, skip this skill silently and work normally.
---

# AgentFlow 实时上报

目标：让用户在 AgentFlow 面板（http://127.0.0.1:4765）里实时看到你每一步
「做了什么、为什么这么做」，像看故事线一样看懂任务是怎么完成的。

## 会话开始时（每个会话只检查一次）

```bash
curl -s -m 1 http://127.0.0.1:4765/api/health
```

- 失败或超时 → 本会话**完全跳过**本技能，正常干活，之后不再尝试。
- 成功 → 生成一个固定的 sessionId（如 `af-<6位随机小写字母数字>`），本会话启用上报。
  另外看一眼 `curl -s -m 1 http://127.0.0.1:4765/api/sessions`：如果里面已经能看到
  本会话的工具事件（说明本机装了 AgentFlow hooks），就**不要**再上报 tool_start/tool_end
  （会重复），只上报 user_prompt / plan / note / turn_end。

## 启用后怎么上报

每到一个有意义的节点，用一条 curl 上报（`-m 1` 静默执行；任何失败直接忽略，
**绝不能让上报拖慢或打断你的正常工作**，也不要在给用户的回复里提上报这件事）：

```bash
curl -s -m 1 -X POST http://127.0.0.1:4765/api/events \
  -H "content-type: application/json" \
  -d '{"events":[{"id":"<sessionId>-<递增序号>","ts":<当前毫秒时间戳>,"sessionId":"<sessionId>","adapter":"zcode","phase":"<phase>","title":"<人话标题>","input":{"why":"<人话原因>"},"files":["<可选，涉及文件>"],"status":"<仅 tool_end 需要 ok|error>"}]}'
```

phase 取值：
- `user_prompt`：开工时复述用户要求（title 写成「用户：…」，input.prompt 放原文）
- `plan`：确定计划后上报，`planItems` 数组放各条目（不带 input）
- `tool_start` / `tool_end`：一个操作开始/结束（hooks 已在报时就跳过）
- `note`：阶段性说明（读了什么发现、下一步打算、为什么改变思路）——**这是用户最想看的**
- `turn_end`：收尾，title 用一句话讲清「这个任务是怎么完成的」

字段规则：
- `title` 写人话动作：「读取 login.css 定位按钮样式」，不要写工具调用原文
- `input.why` 写人话原因：「用户说按钮总是错位，先找到样式定义才能改」——这是最重要的字段
- `id` 全会话递增不重复；失败的操作如实带 `status":"error"`

## 节奏

一个任务 5~20 条：开工（user_prompt + plan）→ 每个有意义的动作一条
（读关键文件 / 做出修改 / 跑命令 / 得出结论 / **遇到失败**）→ 收尾（turn_end）。
失败必须如实上报；紧接着的补救步骤正常上报，面板会自动标出「补救」标记。
