# AgentFlow — AI Agent 执行过程实时流程图

AI 一开始思考、动手，浏览器里的流程图就实时往下长：每一步做了什么、为什么做、
哪一步依赖哪一步（读→改、多步修改→测试验证、计划→子步骤），一目了然。会话结束可回放。

```
ZCode/CC hooks ──────┐
Codex notify+watcher ─┼→ adapter(×N) → HTTP → server(daemon) ─ WebSocket → web(React Flow)
DS-Harness/任意日志 ──┘                      ↓
                                  JSONL 会话存档（回放用）
```

## 快速开始

```bash
npm install
npm run build          # 构建前端（首次必须）
npm run start          # 启动守护进程并自动打开面板 http://127.0.0.1:4765
npm run demo           # 另开终端：推送一段模拟会话，立即看到实时出图
```

## 接入你的 Agent 客户端

### ZCode / Claude Code（hooks，最准）

```bash
npx tsx apps/cli/src/bin.ts install     # 注册 7 种事件的 hooks（先自动备份配置）
```

之后在 ZCode 里的每一步操作都会实时出现在面板上。卸载：`... uninstall`（你自己的 hooks 不受影响）。

### Codex CLI（notify + 会话日志）

`agent-flow start` 会自动监视 `~/.codex/sessions`（细粒度）。
可选增强：在 `~/.codex/config.toml` 加一行（路径见 `install` 命令输出）：

```toml
notify = ["node", "<绝对路径>/adapters/codex/notify.cjs"]
```

### 任意其他 Agent（generic 兜底）

让它往某目录追加 JSONL（每行一个准 AgentEvent，约定见
[adapters/generic/README.md](adapters/generic/README.md)），然后：

```bash
npx tsx apps/cli/src/bin.ts start --watch ~/.my-agent/logs
```

### DeepSeek Harness

插件化框架，优先做 telemetry 插件接入，退路走 generic watcher。
调研清单见 [adapters/ds-harness/README.md](adapters/ds-harness/README.md)（诚实占位，未假装能用）。

## 子项目结构

| 包 | 职责 |
|---|---|
| `packages/protocol` | 统一事件协议 AgentEvent（类型 + zod + fixtures）——唯一契约 |
| `packages/server` | Fastify + ws 守护进程：事件接入、JSONL 存储、WS 广播、静态托管 |
| `packages/inference` | 纯函数推理引擎：事件流 → 节点/边/为什么/计划分组 |
| `packages/web` | React Flow 实时画布 + 详情面板 + 回放 |
| `adapters/zcode` | ZCode/Claude Code hooks 脚本 + 安装器 |
| `adapters/codex` | Codex notify 回调 + sessions 目录 watcher |
| `adapters/generic` | 目录监视兜底，接任意 JSONL 日志 |
| `apps/cli` | `start / demo / install / uninstall / open` 命令 |

## 诚实的边界

- **「为什么」是推断不是原话**：hooks/日志拿不到模型的思考原文，每个节点的原因来自
  用户需求 + 计划条目 + 工具入参的拼接，UI 上标注了来源；拿不到就显示「未知」，不编造。
- **依赖边是启发式**（计划分组 > 同文件读→改 > 修改→验证 > 顺序兜底），偶有猜测成分。
- **Codex 行格式**基于公开样例假设实现，接真实环境后可能需调整 `mapCodexLine`。
- hooks 脚本快进快出、server 不在线时事件丢弃（不阻塞你的 agent）。

## 开发

```bash
npm test               # 全部 53+ 测试
npx vitest run <路径>   # 单包测试
npm run dev -w packages/web   # 前端开发模式（代理到 4765）
```

环境变量：`AGENT_FLOW_PORT`（默认 4765）、`AGENT_FLOW_HOME`（默认 ~/.agent-flow）。

## 致谢 / 参考项目

- [disler/claude-code-hooks-multi-agent-observability](https://github.com/disler/claude-code-hooks-multi-agent-observability) — hooks 捕获 + 实时面板
- [simple10/agents-observe](https://github.com/simple10/agents-observe) — Claude Code + Codex 双端观测
- [anaypaul/claude-session-visualizer](https://github.com/anaypaul/claude-session-visualizer) — 执行树可视化
- 已知坑：直接 tail 会话日志可能中途不刷新（[anthropics/claude-code#70632](https://github.com/anthropics/claude-code/issues/70632)），故本设计以 hooks 为主、tail 为辅。
