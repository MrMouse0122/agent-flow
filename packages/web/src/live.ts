/**
 * 实时数据层：WS 连接 + 纯 reducer 状态机。
 * reducer 完全纯函数（可单测），LiveClient 只负责传输与副作用；
 * 离线演示（demo.ts）复用同一个 reducer，保证与 WS 相同的数据路径。
 */
import type { AgentEvent, Graph, SessionSummary, WsServerMessage } from '@agent-flow/protocol';

/** 连接状态：已连接 / 重连中（含首次连接中）/ 已断开（仍会继续重试） */
export type ConnState = 'connected' | 'reconnecting' | 'disconnected';

export interface LiveState {
  conn: ConnState;
  sessions: SessionSummary[];
  currentSessionId: string | null;
  /** 当前会话的全量事件（live 追加 / history 全量） */
  events: AgentEvent[];
  /** 当前会话最新图（server 推送或本地计算） */
  graph: Graph | null;
}

export type LiveAction =
  | { type: 'conn'; conn: ConnState }
  | { type: 'ws-message'; msg: WsServerMessage }
  | { type: 'select-session'; sessionId: string | null }
  | { type: 'history'; sessionId: string; events: AgentEvent[]; graph: Graph };

export const initialLiveState: LiveState = {
  conn: 'reconnecting',
  sessions: [],
  currentSessionId: null,
  events: [],
  graph: null,
};

const byLastTsDesc = (a: SessionSummary, b: SessionSummary) => b.lastTs - a.lastTs;

/** 追加一条事件：按 id 去重、按 ts 有序插入 */
export function appendEvent(events: AgentEvent[], ev: AgentEvent): AgentEvent[] {
  if (events.some((e) => e.id === ev.id)) return events;
  if (events.length === 0 || ev.ts >= events[events.length - 1]!.ts) return [...events, ev];
  const copy = [...events];
  const idx = copy.findIndex((e) => e.ts > ev.ts);
  copy.splice(idx === -1 ? copy.length : idx, 0, ev);
  return copy;
}

/** 已有事件与拉取到的全量历史做并集（按 id 去重、按 ts 排序），拉取结果优先 */
export function mergeEvents(existing: AgentEvent[], fetched: AgentEvent[]): AgentEvent[] {
  const byId = new Map<string, AgentEvent>();
  for (const ev of existing) byId.set(ev.id, ev);
  for (const ev of fetched) byId.set(ev.id, ev);
  return [...byId.values()].sort((a, b) => a.ts - b.ts);
}

/** 纯 reducer：web 端所有 WS 消息 / 会话切换 / 历史拉取都经过这里 */
export function reduceLive(state: LiveState, action: LiveAction): LiveState {
  switch (action.type) {
    case 'conn':
      return state.conn === action.conn ? state : { ...state, conn: action.conn };

    case 'select-session':
      return {
        ...state,
        currentSessionId: action.sessionId,
        events: [],
        graph: null,
      };

    case 'history': {
      if (action.sessionId !== state.currentSessionId) return state;
      return {
        ...state,
        events: mergeEvents(state.events, action.events),
        graph: action.graph,
      };
    }

    case 'ws-message': {
      const msg = action.msg;

      if (msg.type === 'hello' || msg.type === 'sessions') {
        const sessions = [...msg.sessions].sort(byLastTsDesc);
        return { ...state, sessions };
      }

      if (msg.type === 'session-end') {
        return {
          ...state,
          sessions: state.sessions.map((s) =>
            s.sessionId === msg.sessionId ? { ...s, status: 'ended' as const } : s,
          ),
        };
      }

      // msg.type === 'event'
      const ev = msg.event;
      const isCurrent = ev.sessionId === state.currentSessionId;
      // 当前会话可判重：重复 id 不重复计数（非当前会话信任 server 已去重）
      const isNew = !isCurrent || !state.events.some((e) => e.id === ev.id);
      const known = state.sessions.find((s) => s.sessionId === ev.sessionId);
      let sessions: SessionSummary[];
      if (!known) {
        sessions = [
          {
            sessionId: ev.sessionId,
            adapter: ev.adapter,
            firstTs: ev.ts,
            lastTs: ev.ts,
            title: ev.phase === 'user_prompt' ? ev.title : ev.sessionId,
            eventCount: 1,
            status: 'live',
          },
          ...state.sessions,
        ];
      } else {
        sessions = state.sessions.map((s) =>
          s.sessionId === ev.sessionId
            ? {
                ...s,
                lastTs: Math.max(s.lastTs, ev.ts),
                eventCount: s.eventCount + (isNew ? 1 : 0),
                status: 'live' as const,
              }
            : s,
        );
      }
      if (ev.sessionId !== state.currentSessionId) return { ...state, sessions };
      return { ...state, sessions, events: appendEvent(state.events, ev), graph: msg.graph };
    }
  }
}

/** App 依赖的最小客户端接口（LiveClient 与离线 DemoClient 共用） */
export interface FlowClient {
  getState(): LiveState;
  subscribe(fn: () => void): () => void;
  selectSession(sessionId: string | null): void;
}

const RECONNECT_BACKOFF_MS = [1000, 2000, 4000] as const;

function wsUrl(): string {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  return `${proto}://${location.host}/ws`;
}

/**
 * 实时客户端：维护 WS 连接（1s/2s/4s 退避重连）、会话列表、当前会话事件与图。
 * 换会话时通过 REST 拉全量事件 + 当前图。
 */
export class LiveClient implements FlowClient {
  private state: LiveState = initialLiveState;
  private listeners = new Set<() => void>();
  private ws: WebSocket | null = null;
  private retries = 0;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private closed = false;
  /** 当前正在拉取/展示的会话（防止慢请求覆盖新选择） */
  private selected: string | null = null;

  constructor() {
    this.connect();
  }

  getState = (): LiveState => this.state;

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  };

  selectSession(sessionId: string | null): void {
    this.selected = sessionId;
    this.dispatch({ type: 'select-session', sessionId });
    if (sessionId) void this.fetchHistory(sessionId);
  }

  destroy(): void {
    this.closed = true;
    clearTimeout(this.retryTimer);
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        /* 忽略 */
      }
    }
    this.listeners.clear();
  }

  private dispatch(action: LiveAction): void {
    const next = reduceLive(this.state, action);
    if (next !== this.state) {
      this.state = next;
      for (const fn of this.listeners) fn();
    }
  }

  private connect(): void {
    if (this.closed) return;
    let ws: WebSocket;
    try {
      ws = new WebSocket(wsUrl());
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      const wasReconnect = this.retries > 0;
      this.retries = 0;
      this.dispatch({ type: 'conn', conn: 'connected' });
      // 断线期间本会话可能漏了事件：重连成功后补拉一次历史（mergeEvents 按 id 去重）
      if (wasReconnect && this.selected) void this.fetchHistory(this.selected);
    };
    ws.onmessage = (m: MessageEvent) => {
      try {
        const msg = JSON.parse(String(m.data)) as WsServerMessage;
        this.dispatch({ type: 'ws-message', msg });
      } catch {
        /* 非 JSON 消息直接丢弃 */
      }
    };
    ws.onclose = () => this.scheduleReconnect();
    ws.onerror = () => {
      try {
        ws.close();
      } catch {
        /* 忽略 */
      }
    };
  }

  private scheduleReconnect(): void {
    if (this.closed) return;
    const delay = RECONNECT_BACKOFF_MS[Math.min(this.retries, RECONNECT_BACKOFF_MS.length - 1)]!;
    this.retries += 1;
    this.dispatch({ type: 'conn', conn: this.retries >= 4 ? 'disconnected' : 'reconnecting' });
    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => this.connect(), delay);
  }

  private async fetchHistory(sessionId: string): Promise<void> {
    try {
      const [evRes, graphRes] = await Promise.all([
        fetch(`/api/sessions/${encodeURIComponent(sessionId)}/events`),
        fetch(`/api/sessions/${encodeURIComponent(sessionId)}/graph`),
      ]);
      if (!evRes.ok || !graphRes.ok) return;
      const events = (await evRes.json()) as AgentEvent[];
      const graph = (await graphRes.json()) as Graph;
      if (this.selected !== sessionId) return; // 用户已切走，丢弃过期响应
      this.dispatch({ type: 'history', sessionId, events, graph });
    } catch {
      /* 离线时静默失败，等待重连 */
    }
  }
}
