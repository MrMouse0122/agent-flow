/**
 * AgentFlow 统一事件协议 —— 全项目唯一契约。
 * adapter 只负责把各客户端的原始信号翻译成 AgentEvent；
 * server / inference / web 只消费 AgentEvent，不感知具体客户端。
 */

/** 事件来源的适配器（也是客户端标识） */
export type AdapterId = 'zcode' | 'codex' | 'ds-harness' | 'generic' | 'demo';

export type EventPhase =
  | 'user_prompt' // 用户提出问题/需求
  | 'plan' // 计划/任务列表快照
  | 'tool_start' // 工具调用开始（AI 开始动手）
  | 'tool_end' // 工具调用结束
  | 'turn_end' // 一轮回答结束
  | 'note'; // 其他说明性事件（如 SessionStart）

export interface AgentEvent {
  /** 全局唯一：适配器生成，如 `${adapter}:${sessionId}:${seq}` */
  id: string;
  /** epoch 毫秒 */
  ts: number;
  sessionId: string;
  adapter: AdapterId;
  phase: EventPhase;
  /** 工具名：Read / Edit / Write / Bash / Grep / Agent ... */
  tool?: string;
  /** 人话标题，如「读取 src/config.ts」，图上直接展示 */
  title: string;
  /** 本步涉及的文件路径（依赖推断用） */
  files?: string[];
  input?: unknown;
  output?: unknown;
  /** phase === 'plan' 时的计划条目（有序） */
  planItems?: string[];
  /** phase === 'tool_end' 时的结果状态 */
  status?: 'ok' | 'error';
  /** 原始 payload（截断后），排查用 */
  raw?: unknown;
}

/** 「为什么做这一步」的证据，UI 必须如实标注来源，不许编造 */
export interface WhySource {
  text: string;
  source: 'user' | 'plan' | 'tool-input' | 'unknown';
}

export type StepKind = 'prompt' | 'plan-item' | 'tool' | 'turn-end' | 'note';
export type StepStatus = 'running' | 'ok' | 'error' | 'pending';

export interface StepNode {
  id: string;
  label: string;
  kind: StepKind;
  status: StepStatus;
  tool?: string;
  files?: string[];
  why: WhySource[];
  /** 支撑本节点的事件 id（tool_start + tool_end 合并进同一节点） */
  eventIds: string[];
  ts: number;
  /** 所属计划条目节点 id（plan-item 分组） */
  parentPlanItemId?: string;
}

export type EdgeKind =
  | 'contains' // prompt → plan-item
  | 'read-edit' // 同文件：先读后改
  | 'verify' // 多步修改 → 测试/构建验证
  | 'seq'; // 顺序兜底（弱样式渲染）

export interface GraphEdge {
  from: string;
  to: string;
  kind: EdgeKind;
}

export interface Graph {
  sessionId: string;
  nodes: StepNode[];
  edges: GraphEdge[];
}

export interface SessionSummary {
  sessionId: string;
  adapter: AdapterId;
  firstTs: number;
  lastTs: number;
  /** user_prompt 摘要，取不到则用 sessionId */
  title: string;
  eventCount: number;
  status: 'live' | 'ended';
}

/** server → web 的 WebSocket 消息 */
export type WsServerMessage =
  | { type: 'hello'; sessions: SessionSummary[] }
  | { type: 'sessions'; sessions: SessionSummary[] }
  | { type: 'event'; event: AgentEvent; graph: Graph }
  | { type: 'session-end'; sessionId: string };
