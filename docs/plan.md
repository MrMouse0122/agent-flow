# AgentFlow 实施计划

> 执行方式：主会话 + 多子代理并行。协议（Task 1）冻结后才开工并行任务。
> 规格见 `docs/spec.md`（设计文档，随计划一起读）。

**目标**：本地常驻平台，接入多个编码 Agent 客户端（ZCode/Codex/DS-Harness/任意 CLI），AI 一开始思考，浏览器里就实时长出「做了什么 / 为什么 / 依赖关系」的流程图，可回放。

**架构**：统一事件协议 AgentEvent 为唯一契约 → adapter 把各客户端信号翻译成事件 POST 给 server 守护进程 → server 存 JSONL、算图、WS 推送 → web 用 React Flow 实时渲染。推理（inference）是纯函数库，server 与 web 共用。

**技术栈**：Node ≥ 20 + TypeScript + npm workspaces；fastify、ws、zod、chokidar、@xyflow/react、elkjs、vitest、tsx、Vite。

## 全局约束

- Windows 一等公民：所有可执行脚本不用 bash-only 语法；hook 用 process 型或 node 直跑。
- 端口 4765（env `AGENT_FLOW_PORT` 可覆盖）；数据目录 `~/.agent-flow`（env `AGENT_FLOW_HOME` 可覆盖）。
- 无数据库：每会话一个 append-only JSONL 文件（`<home>/sessions/<sessionId>.jsonl`）。
- adapter/hook 绝不阻塞宿主：总超时 ≤ 1s、任何异常静默吞掉、exit 0、stdout 不输出（ZCode 会把 stdout 按 strict JSON 解析）。
- 大 payload 截断：入库/广播前 input/output 经 `truncateDeep`（协议包提供）。
- 依赖最小集（见各 package.json），其余用 Node 标准库。
- 包内源码直接互相引用（exports 指 src/index.ts，tsx/vite/vitest 直接吃 TS 源码），不做 tsc emit；唯一例外 adapters/zcode/hook.cjs 为零依赖单文件。

## 冻结接口（packages/protocol，所有子项目共用，不得擅改）

```ts
type AdapterId = 'zcode' | 'codex' | 'ds-harness' | 'generic' | 'demo';
type EventPhase = 'user_prompt' | 'plan' | 'tool_start' | 'tool_end' | 'turn_end' | 'note';
interface AgentEvent {
  id: string; ts: number; sessionId: string; adapter: AdapterId; phase: EventPhase;
  tool?: string; title: string; files?: string[];
  input?: unknown; output?: unknown; planItems?: string[];
  status?: 'ok' | 'error'; raw?: unknown;
}
interface WhySource { text: string; source: 'user' | 'plan' | 'tool-input' | 'unknown'; }
type StepKind = 'prompt' | 'plan-item' | 'tool' | 'turn-end';
type StepStatus = 'running' | 'ok' | 'error' | 'pending';
interface StepNode { id: string; label: string; kind: StepKind; status: StepStatus; tool?: string;
  files?: string[]; why: WhySource[]; eventIds: string[]; ts: number; parentPlanItemId?: string; }
type EdgeKind = 'contains' | 'read-edit' | 'verify' | 'seq';
interface GraphEdge { from: string; to: string; kind: EdgeKind; }
interface Graph { sessionId: string; nodes: StepNode[]; edges: GraphEdge[]; }
interface SessionSummary { sessionId: string; adapter: AdapterId; firstTs: number; lastTs: number;
  title: string; eventCount: number; status: 'live' | 'ended'; }
type WsServerMessage =
  | { type: 'hello'; sessions: SessionSummary[] }
  | { type: 'sessions'; sessions: SessionSummary[] }
  | { type: 'event'; event: AgentEvent; graph: Graph }
  | { type: 'session-end'; sessionId: string };
// zod: agentEventSchema（已知字段严格校验 + passthrough raw）；truncateDeep(value, maxLen=2000)
// inference 核心: buildGraph(events: AgentEvent[]): Graph  （幂等、纯函数）
```

## HTTP API（packages/server）

- `POST /api/events`  body `{ events: AgentEvent[] }` → 校验→截断→追加 JSONL→广播→`202 {accepted:n}`（server 不重算 session 归属，按事件字段存）
- `GET /api/sessions` → `SessionSummary[]`
- `GET /api/sessions/:id/events` → `AgentEvent[]`
- `GET /api/sessions/:id/graph` → `Graph`
- `WS /ws` → 按 WsServerMessage 推送；新连接先发 hello
- 生产模式静态托管 `packages/web/dist`

## 任务分解

| # | 任务 | 负责 | 交付与验证 |
|---|------|------|-----------|
| 0 | monorepo 骨架 + 计划/规格 | 主会话 | `npm install` 通过；git 首次提交 |
| 1 | packages/protocol | 主会话（先做，冻结契约） | vitest：fixtures 过 schema、坏数据被拒、truncateDeep 生效 |
| 2 | packages/server | 子代理A | fastify.inject 测试：POST 事件→JSONL 落盘→WS 收到 event+graph→sessions/graph 接口正确；乱序/重复 id 幂等 |
| 3 | packages/inference | 子代理B | 纯函数 + fixtures 测试：计划父节点+contains 边、同文件 read→edit 边、修改→测试 verify 边、无计划时 seq 兜底、error 后重试成链、tool_start 未配对→running |
| 4 | packages/web | 子代理C | Vite+React Flow：会话列表、实时 DAG（elkjs 布局、状态着色、运行中呼吸动画）、节点详情面板（why 来源标注）、回放滑杆（按 ts 逐事件重建图）；dev 代理 4765 |
| 5 | adapters/* | 子代理D | zcode/hook.cjs（stdin JSON→事件映射→POST，快进快出）+ 安装器（合并写 `~/.zcode/cli/config.json`，先备份，幂等，可卸载）；codex watcher（chokidar 监视 ~/.codex/sessions，JSONL 增量解析，offset 去重）；generic watcher（目录+正则配置化）；各有单测（喂样例 payload/临时日志文件） |
| 6 | apps/cli | 主会话 | `start`（起 server+开浏览器）、`demo`（把 fixtures 按延迟 POST，模拟实时会话）、`install/uninstall`（调 zcode 安装器）、`open` |
| 7 | 集成联调 | 主会话 | `npm run demo` + 浏览器截图验证实时出图、详情、回放 |
| 8 | README + 收尾 | 主会话 | 启动/接入说明、参考项目（见 spec）、全量 vitest 绿 |

## Review Focus（易翻车点 → 归属任务）

1. hook 拖慢/弄崩宿主 agent → T5：单测断言 hook 总 exit 0、无 stdout、超时 <1s。
2. 重复/乱序事件把图画坏 → T2/T3：重复 id 只算一次；乱序 ts 按 ts 排序后构图，buildGraph 幂等（同输入同输出）。
3. 巨大 tool_output 打爆存储/带宽 → T1/T2：truncateDeep 截断后再落盘广播。
4. server 不在线时事件全丢还不报错 → T5：hook 静默失败可接受（README 说明）；server 重启能从 JSONL 恢复会话列表 → T2 测试。
5. 多会话/多 adapter 串线 → T2/T4：按 sessionId 隔离文件与广播；web 切换会话。

## 参考项目（借鉴方向）

- disler/claude-code-hooks-multi-agent-observability（hooks 捕获+实时面板）
- simple10/agents-observe（Claude Code + Codex 双端观测）
- anaypaul/claude-session-visualizer（执行树可视化）
- 已知坑：直接 tail 会话 JSONL 可能中途不刷新（anthropics/claude-code#70632）——所以本设计以 hooks 为主、tail 为辅。
