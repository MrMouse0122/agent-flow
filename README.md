# AgentFlow — AI Agent 执行过程实时可视化

AI 一开始思考、动手，面板就实时长出可视化：**故事线**（默认，像读日志一样看懂"任务是怎么完成的"：
大白话总结 + 按时间排列的每一步、为什么、失败与补救）和**流程图**（DAG，看步骤间依赖：读→改、修改→验证、计划分组）。
支持浅色/深色双主题（默认浅色，侧栏底部一键切换），会话结束可回放。

```
ZCode hooks ────────┐
ZCode skill（AI 自述）─┤
Codex notify+watcher ─┼→ adapter(×N) → HTTP → server(daemon) ─ WebSocket → web 面板
WorkBuddy watcher ────┤                      ↓
DeepSeek Harness 插件 ─┤           JSONL 会话存档（回放用）
任意 JSONL 日志 ──────┘
```

## 环境要求

- Node.js ≥ 20.11（用了 `import.meta.dirname` 等 API；实测环境 24.17）
- Windows 为主力开发与实测平台（hook / notify / watcher 脚本均为零依赖 Node 脚本，理论上跨平台，macOS/Linux 未实测）
- 无需数据库：面板数据是 append-only JSONL，存 `~/.agent-flow/sessions/`

## 快速开始

```bash
npm install
npm run build          # 构建前端（首次必须）
npm run start          # 启动守护进程并自动打开面板 http://127.0.0.1:4765
npm run demo           # 另开终端：推送模拟会话（skill 风格，AI 原话 why）
```

启动后什么都不用配：在已接入的客户端里正常干活，面板会自动出现会话并实时生长。
日常使用（看故事线 / 切流程图 / 点节点看为什么 / 回放倍速）全部在网页里点选完成；
更多运维命令（清理会话、隔离端口冒烟、全量校验）见 [HANDOVER.md](HANDOVER.md)。

## 接入你的 Agent 客户端

### ZCode / Claude Code

两种方式，可同时用（skill 会自动避免与 hooks 重复上报）：

```bash
npx tsx apps/cli/src/bin.ts skill        # 推荐：安装「实时上报」skill → ~/.zcode/skills/agent-flow
                                         # 之后每个会话里 AI 自己叙述每一步「做了什么/为什么」，
                                         # why 是 AI 原话（面板上最有人味的模式）；server 不在线自动跳过
npx tsx apps/cli/src/bin.ts install      # 可选：注册 7 种事件 hooks（结构化工具事件，无需 AI 配合）
```

卸载：`... skill --remove` / `... uninstall`（你自己的配置不受影响）。

### Codex CLI

`agent-flow start` 自动监视 `~/.codex/sessions`，按 openai/codex 真实 rollout 格式解析
（`session_meta`、`event_msg` 的 user_message/agent_message/task_complete、`response_item` 的
message/function_call；reasoning 与 function_call_output 自动忽略），行内 `timestamp` 作为事件时间，
顶层扁平的旧格式同样兼容。可选增强：在 `~/.codex/config.toml` 加
`notify = ["node", "<绝对路径>/adapters/codex/notify.cjs"]`（路径见 `install` 命令输出）。

### WorkBuddy

`agent-flow start` 检测到 `~/.workbuddy` 时自动监视其审计日志、变更索引与会话标题快照
（只读，零依赖；详见 [adapters/workbuddy/README.md](adapters/workbuddy/README.md)）。
对话正文在 SQLite 中，面板如实标注此局限（user_prompt 为侧栏标题合成）。

### DeepSeek Harness

按官方插件姿势接入：dsh 的 Cordis 插件订阅会话事件总线（user/message、tool/call、
todo/write、turn/end…），映射为面板节点。挂载方式见
[adapters/ds-harness/README.md](adapters/ds-harness/README.md)（`agent-flow start`
检测到 `~/.dsh` 会打印现成命令）。

### 任意其他 Agent（generic 兜底）

让它往某目录追加 JSONL（每行一个准 AgentEvent，约定见
[adapters/generic/README.md](adapters/generic/README.md)），然后
`npx tsx apps/cli/src/bin.ts start --watch ~/.my-agent/logs`。

## 面板功能

- **故事线视图（默认）**：顶部大白话总结（分几步、多少操作、几次失败、最终结论）；
  时间线上每步带类型徽章（提问/计划/AI 说明/工具/完成）、`↳ 为什么`、失败标红、补救标记；
  点击任意行看详情（why 来源、输入输出 JSON、相关文件、关联事件）。
- **流程图视图**：React Flow + elk 自动布局；提问节点反白强调、计划分组容器、
  读→改实线 / 验证虚线 / 顺序点线、状态着色（成功绿/失败红/进行中呼吸）。
- **实时 & 回放**：新事件 WS 推送实时长图；暂停后拖滑杆逐事件回放（1x/2x/4x）。
- **双主题**：浅色默认（BH 报告页同款 zinc 浅色 token），深色一键切换，选择会被记住。

## 子项目结构

| 包 | 职责 |
|---|---|
| `packages/protocol` | 统一事件协议 AgentEvent（类型 + zod + fixtures）——唯一契约 |
| `packages/server` | Fastify + ws 守护进程：事件接入、JSONL 存储、WS 广播、静态托管 |
| `packages/inference` | 纯函数推理引擎：事件流 → 节点/边/为什么/计划分组/故事 |
| `packages/web` | 故事线 + 流程图双视图面板（React Flow + elkjs，双主题） |
| `adapters/zcode` | ZCode/Claude Code hooks 脚本 + 安装器 |
| `adapters/skill` | 「实时上报」skill 本体（AI 自述为什么） |
| `adapters/codex` | Codex notify 回调 + sessions 目录 watcher |
| `adapters/workbuddy` | WorkBuddy 审计日志/变更索引/会话标题三源 watcher |
| `adapters/ds-harness` | DeepSeek Harness telemetry 插件（Cordis `ctx.on('session/event')`） |
| `adapters/generic` | 目录监视兜底，接任意 JSONL 日志 |
| `apps/cli` | `start / demo / install / uninstall / skill / open` 命令 |

## 诚实的边界

- hooks/日志模式拿不到模型思考原文，「为什么」来自 用户需求+计划+工具入参 的拼接推断，
  UI 如实标注来源；**装了 skill 后 why 是 AI 原话**，两者共存时自动互补。
- 依赖边是启发式（计划分组 > 同文件读→改 > 修改→验证 > 顺序兜底）。
- Codex rollout 字段名以 openai/codex 当前实现为参照，若上游改格式需同步调整 `mapCodexLine`。
- hooks/上报脚本快进快出，server 不在线时事件丢弃（不阻塞你的 agent）；断线重连后
  面板会自动补拉当前会话历史，只丢 server 完全不在线窗口内的事件。

## 开发

```bash
npm test                              # 全部 91 测试
npm run typecheck                     # 全包 tsc --noEmit（tsconfig 已禁原地发射 .js）
npx vitest run <路径>                  # 单包测试
npm run dev -w packages/web           # 前端开发模式（代理到 4765）
npm run build -w packages/web         # 重新构建前端
```

环境变量：`AGENT_FLOW_PORT`（默认 4765）、`AGENT_FLOW_HOME`（默认 ~/.agent-flow）。

清理误报/演示会话：`curl -X DELETE http://127.0.0.1:4765/api/sessions/<sessionId>`
（内存与磁盘存档一并删除，在线面板即时消失）。

## 致谢 / 参考项目

- [disler/claude-code-hooks-multi-agent-observability](https://github.com/disler/claude-code-hooks-multi-agent-observability)
- [simple10/agents-observe](https://github.com/simple10/agents-observe)
- [anaypaul/claude-session-visualizer](https://github.com/anaypaul/claude-session-visualizer)
- 已知坑：直接 tail 会话日志可能中途不刷新（[anthropics/claude-code#70632](https://github.com/anthropics/claude-code/issues/70632)），故以 hooks/skill 为主、tail 为辅。
