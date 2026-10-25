# 任务：构建「AgentFlow」—— 多 Agent 执行过程实时流程图可视化平台

## 我要什么

一个本地常驻的可视化平台，接入我常用的多个编码 Agent 客户端（ZCode / Claude Code、OpenAI Codex CLI、DeepSeek Harness 等）。我在任何一个客户端里提问、AI 开始思考时，浏览器里的流程图就**自动**开始实时生长：

- 每执行一步（提问、规划、读文件、改代码、跑命令、搜索……）图上实时长出一个节点；
- 点开节点能看到：这一步**做了什么**、**为什么做**（关联的用户需求与计划条目）、工具输入/输出摘要；
- 节点间有依赖边，能看出「哪一步为了实现哪一步」（读→改、多步修改→测试验证、计划→子步骤）；
- 会话结束可回放；
- **接入一个新客户端 = 只新增一个 adapter 子项目，其余代码一律不动。**

## 总体架构

核心思想：一切围绕统一事件协议 **AgentEvent**。adapter 只负责把各客户端的原始信号翻译成 AgentEvent 发给 server；inference 只消费 AgentEvent 生成图；web 只消费图。协议是唯一契约。

```
ZCode/CC hooks ──────┐
Codex notify+watcher ─┼→ adapter(×N) → HTTP POST → server(daemon) ─ WebSocket → web(React Flow)
DS-Harness 插件/日志 ─┘                         ↓
                                     JSONL 会话存档（回放用）
```

AgentEvent 要点：`{ id, ts, sessionId, adapter, phase: user_prompt | plan | tool_start | tool_end | turn_end | error, tool?, title, input?, output?, planItems?, raw? }`。在 `packages/protocol` 定型，附 zod 校验和每个 phase 的 fixture 样例。

## 子项目划分（pnpm workspaces monorepo，每个独立可构建、可测试）

```
agent-flow/
├─ packages/
│  ├─ protocol/     # 统一事件协议：类型 + zod 校验 + fixtures（唯一契约）
│  ├─ server/       # 常驻守护进程：Fastify + ws，事件接入、会话管理、JSONL 存储、WS 广播
│  ├─ inference/    # 纯函数库：AgentEvent 流 → 节点/边/why/分组（无 IO，可单测）
│  └─ web/          # React Flow 实时画布 + 详情面板 + 回放控制
├─ adapters/
│  ├─ zcode/        # ZCode / Claude Code hooks 脚本 + 自动安装器
│  ├─ codex/        # Codex CLI：notify 回调 + sessions 目录 watcher
│  ├─ ds-harness/   # DeepSeek Harness：插件式接入，退路是 tail 会话日志
│  └─ generic/      # 兜底：配置化日志 watcher 或 wrapper 启动器，接任意 CLI
└─ apps/
   └─ cli/          # agent-flow 命令：install / uninstall / start / stop / open
```

## 各客户端接入方式（动手前先查各客户端当前官方文档核实，并在该子项目 README 写明依据）

1. **adapters/zcode**：注册 PreToolUse / PostToolUse / UserPromptSubmit / Stop hooks（配置片段由 `install` 命令自动写入客户端 settings），hook 脚本读 stdin JSON → POST server。
2. **adapters/codex**：两条腿——① `~/.codex/config.toml` 的 `notify` 指向我们的回调脚本（事件粒度粗：回合完成）；② server 内置 watcher 监视 `~/.codex/sessions/*.jsonl`（粒度细：每个工具调用），两者按 session_id 对齐合并。
3. **adapters/ds-harness**：DeepSeek Harness 是插件化框架（模型/工具/会话/循环层皆可插件扩展）——优先调研其插件 API，做成官方姿势的 telemetry 插件；不行就退化为 tail 其会话日志。
4. **adapters/generic**：兜底。两种模式：a) 「日志目录 + 行解析规则」的配置化 watcher；b) wrapper 启动器 `agent-flow run -- <任意CLI>`，tee 终端输出送 server。任何没专门 adapter 的客户端都能这样接入（信息有损，UI 如实标注）。

## 自动激活（关键体验）

- `agent-flow install`（apps/cli）一次性完成：写入各客户端配置 + 注册自启；
- server 作为后台守护进程常驻（Windows 下开机自启，或由首个事件拉起），监听 localhost:4765；
- watcher 类 adapter（codex / generic）随 server 启动自动开启，监视各自日志目录；
- 任何客户端的新会话第一个事件到达 → 面板自动新增该会话并开始画图，可配置自动弹出新浏览器标签页。

## 技术约束

- Node.js ≥ 20，全 TypeScript；pnpm workspaces（构建用 turbo 或 npm -w，越简单越好）；
- 依赖最小集：fastify、ws、zod、chokidar、@xyflow/react、elkjs，其余标准库能解决就用标准库；
- Windows 必须一等公民（我在 Windows 上用；hook / wrapper 脚本不许写成 bash-only）；
- 不引入数据库：每会话一个 append-only JSONL 文件；回放 = 按时间戳重放；
- adapter 脚本快进快出（转发完就退出），绝不阻塞宿主 agent。

## 里程碑（严格按序；M1 之后各 adapter 子项目独立交付、独立验收）

- **M0 协议定型**：packages/protocol 的类型 + zod 校验 + fixtures；
- **M1 端到端打通**：server + web 事件列表 + zcode adapter——我在 ZCode 里提问，页面实时滚动事件；
- **M2 出图**：inference v1 + web 实时 DAG（elkjs 自动布局、节点状态着色：进行中=蓝色呼吸/成功=绿/失败=红）；
- **M3 语义**：why 面板（用户需求+计划+工具入参拼接，标注来源）+ 依赖边启发式（计划分组 > 同文件读→改 > 修改→验证 > 顺序兜底）+ 计划分组；
- **M4 多端接入**：codex、ds-harness、generic 至少完成两个 + install 命令 + 守护进程自启；回放（倍速）、失败重试链、视觉打磨。

## 验收

1. `agent-flow install && agent-flow start` 之后，在 ZCode 和 Codex 里各问一个小任务（读两个文件、改一个文件、跑一次测试），两个会话都在面板自动出现并实时出图；
2. 图上有计划父节点 + 步骤子节点 + 依赖边；点节点能看到「为什么」和工具输入/输出；
3. 关掉页面再打开，可完整回放任一会话；
4. 用一个只有日志文件的假想客户端（指定日志目录）验证 generic adapter 也能出图（允许信息有损）。

## 特别注意

- hook / notify / 插件的具体注册方式与 payload 字段以各客户端**当前**官方文档为准，每个 adapter 动手前先查证；
- 「为什么」只能来自 用户需求 + 计划 + 工具入参 的拼接推断，UI 上如实标注来源，不伪装成 agent 原话；拿不到就标「未知」，不许编造；
- 多客户端并发会话按 sessionId + adapter 区分，互不串线。
