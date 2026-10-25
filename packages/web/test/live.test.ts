/** LiveClient 消息处理 reducer 的纯逻辑单测 */
import { describe, expect, it } from 'vitest';
import type { AgentEvent, Graph, SessionSummary, WsServerMessage } from '@agent-flow/protocol';
import { appendEvent, initialLiveState, mergeEvents, reduceLive } from '../src/live';

let seq = 0;
const ev = (over: Partial<AgentEvent> & Pick<AgentEvent, 'ts' | 'phase' | 'title'>): AgentEvent => {
  seq += 1;
  return {
    id: `t:s1:${String(seq).padStart(3, '0')}`,
    sessionId: 's1',
    adapter: 'zcode',
    ...over,
  } as AgentEvent;
};

const emptyGraph = (sessionId: string): Graph => ({ sessionId, nodes: [], edges: [] });

const summary = (over: Partial<SessionSummary> & Pick<SessionSummary, 'sessionId'>): SessionSummary => ({
  adapter: 'zcode',
  firstTs: 1000,
  lastTs: 2000,
  title: '会话',
  eventCount: 2,
  status: 'live',
  ...over,
});

describe('reduceLive：hello / sessions', () => {
  it('hello 替换会话列表并按 lastTs 倒序', () => {
    const msg: WsServerMessage = {
      type: 'hello',
      sessions: [summary({ sessionId: 'old', lastTs: 100 }), summary({ sessionId: 'new', lastTs: 900 })],
    };
    const next = reduceLive(initialLiveState, { type: 'ws-message', msg });
    expect(next.sessions.map((s) => s.sessionId)).toEqual(['new', 'old']);
    expect(next.conn).toBe('reconnecting'); // hello 不改变连接状态，由 onopen 维护
  });
});

describe('reduceLive：event', () => {
  const base = reduceLive(initialLiveState, {
    type: 'ws-message',
    msg: { type: 'hello', sessions: [summary({ sessionId: 's1' })] },
  });

  it('当前会话的事件追加并更新 graph 与摘要', () => {
    const selected = reduceLive(base, { type: 'select-session', sessionId: 's1' });
    const e1 = ev({ ts: 1000, phase: 'user_prompt', title: '用户：修个 bug' });
    const g = emptyGraph('s1');
    const next = reduceLive(selected, {
      type: 'ws-message',
      msg: { type: 'event', event: e1, graph: g },
    });
    expect(next.events.map((e) => e.id)).toEqual([e1.id]);
    expect(next.graph).toBe(g);
    expect(next.sessions[0]!.eventCount).toBe(3);
    expect(next.sessions[0]!.status).toBe('live');
  });

  it('重复 id 幂等：不追加、计数不变', () => {
    const selected = reduceLive(base, { type: 'select-session', sessionId: 's1' });
    const e1 = ev({ ts: 1000, phase: 'tool_start', tool: 'Read', title: '读文件' });
    const withOne = reduceLive(selected, { type: 'ws-message', msg: { type: 'event', event: e1, graph: emptyGraph('s1') } });
    const withDup = reduceLive(withOne, {
      type: 'ws-message',
      msg: { type: 'event', event: { ...e1 }, graph: emptyGraph('s1') },
    });
    expect(withDup.events).toHaveLength(1);
    expect(withDup.sessions[0]!.eventCount).toBe(3); // 只涨了一次
  });

  it('乱序 ts 按 ts 插入到正确位置', () => {
    const selected = reduceLive(base, { type: 'select-session', sessionId: 's1' });
    const e2 = ev({ ts: 2000, phase: 'tool_start', tool: 'Edit', title: '改文件' });
    const e1 = ev({ ts: 1000, phase: 'tool_start', tool: 'Read', title: '读文件' });
    let s = reduceLive(selected, { type: 'ws-message', msg: { type: 'event', event: e2, graph: emptyGraph('s1') } });
    s = reduceLive(s, { type: 'ws-message', msg: { type: 'event', event: e1, graph: emptyGraph('s1') } });
    expect(s.events.map((e) => e.ts)).toEqual([1000, 2000]);
  });

  it('其他会话的事件只更新会话列表，不动当前 events/graph', () => {
    const selected = reduceLive(base, { type: 'select-session', sessionId: 's1' });
    const other = ev({ ts: 3000, phase: 'tool_start', tool: 'Bash', title: '跑命令' });
    other.sessionId = 's2';
    const next = reduceLive(selected, {
      type: 'ws-message',
      msg: { type: 'event', event: other, graph: emptyGraph('s2') },
    });
    expect(next.events).toHaveLength(0);
    expect(next.graph).toBeNull();
    expect(next.sessions).toHaveLength(2); // 新会话自动出现
    expect(next.sessions.find((s) => s.sessionId === 's2')!.status).toBe('live');
  });
});

describe('reduceLive：session-end / select / history', () => {
  it('session-end 把对应会话标记为 ended', () => {
    const base = reduceLive(initialLiveState, {
      type: 'ws-message',
      msg: { type: 'hello', sessions: [summary({ sessionId: 's1' }), summary({ sessionId: 's2' })] },
    });
    const next = reduceLive(base, { type: 'ws-message', msg: { type: 'session-end', sessionId: 's1' } });
    expect(next.sessions.find((s) => s.sessionId === 's1')!.status).toBe('ended');
    expect(next.sessions.find((s) => s.sessionId === 's2')!.status).toBe('live');
  });

  it('select-session 清空 events/graph；history 合并去重并按 ts 排序', () => {
    const e1 = ev({ ts: 1000, phase: 'tool_start', tool: 'Read', title: '读' });
    const e2 = ev({ ts: 2000, phase: 'tool_start', tool: 'Edit', title: '改' });
    const e3 = ev({ ts: 3000, phase: 'tool_end', tool: 'Edit', title: '改完', status: 'ok' });
    const e4 = ev({ ts: 4000, phase: 'turn_end', title: '完成' });

    let s = reduceLive(initialLiveState, { type: 'select-session', sessionId: 's1' });
    expect(s.events).toHaveLength(0);
    expect(s.graph).toBeNull();

    // 拉取期间已实时收到 e1、e3
    s = reduceLive(s, { type: 'ws-message', msg: { type: 'event', event: e1, graph: emptyGraph('s1') } });
    s = reduceLive(s, { type: 'ws-message', msg: { type: 'event', event: e3, graph: emptyGraph('s1') } });
    // 全量历史返回 [e1,e2,e3,e4]
    s = reduceLive(s, { type: 'history', sessionId: 's1', events: [e1, e2, e3, e4], graph: emptyGraph('s1') });

    expect(s.events.map((e) => e.ts)).toEqual([1000, 2000, 3000, 4000]);
    expect(s.events).toHaveLength(4);
    expect(s.graph).toEqual(emptyGraph('s1'));
  });

  it('history 对非当前会话的过期响应直接忽略', () => {
    const s = reduceLive(initialLiveState, { type: 'select-session', sessionId: 's1' });
    const stale = reduceLive(s, { type: 'history', sessionId: 's2', events: [], graph: emptyGraph('s2') });
    expect(stale).toBe(s);
  });
});

describe('appendEvent / mergeEvents', () => {
  it('appendEvent 空数组与尾部追加', () => {
    const e1 = ev({ ts: 1, phase: 'note', title: 'a' });
    const e2 = ev({ ts: 2, phase: 'note', title: 'b' });
    expect(appendEvent([], e1)).toEqual([e1]);
    expect(appendEvent([e1], e2)).toEqual([e1, e2]);
  });

  it('mergeEvents 按 id 去重、按 ts 排序', () => {
    const a1 = ev({ ts: 1, phase: 'note', title: 'a1' });
    const a2 = ev({ ts: 3, phase: 'note', title: 'a2' });
    const b2 = ev({ ts: 2, phase: 'note', title: 'b2' });
    const merged = mergeEvents([a1, a2], [a2, b2]);
    expect(merged.map((e) => e.ts)).toEqual([1, 2, 3]);
    expect(merged).toHaveLength(3);
  });
});
