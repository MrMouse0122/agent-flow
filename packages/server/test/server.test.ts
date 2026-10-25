import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { demoSession, type AgentEvent, type WsServerMessage } from '@agent-flow/protocol';
import { createApp, type AppContext } from '../src/index.js';
import { SessionStore } from '../src/store.js';

let ctx: AppContext;

beforeAll(async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'agent-flow-test-'));
  ctx = await createApp({ dataDir, port: 0 });
});

afterAll(async () => {
  await ctx.close();
});

const post = (events: unknown[]) => ctx.app.inject({ method: 'POST', url: '/api/events', payload: { events } });

describe('事件接入 API', () => {
  it('POST demoSession → 全部接受、落盘、可查询', async () => {
    const res = await post(demoSession);
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ accepted: 15, rejected: 0 });

    const file = join(ctx.store.dataDir, 'sessions', 'demo-1.jsonl');
    expect(existsSync(file)).toBe(true);
    expect(readFileSync(file, 'utf8').trim().split('\n')).toHaveLength(15);

    const events = await ctx.app.inject({ method: 'GET', url: '/api/sessions/demo-1/events' });
    expect(events.statusCode).toBe(200);
    const list = events.json() as AgentEvent[];
    expect(list).toHaveLength(15);
    expect(list.map((e) => e.ts)).toEqual([...list.map((e) => e.ts)].sort((a, b) => a - b));
  });

  it('重复 POST 同批事件 → 幂等，不重复入库', async () => {
    const res = await post(demoSession);
    expect(res.json()).toEqual({ accepted: 0, rejected: 0 });
    const events = await ctx.app.inject({ method: 'GET', url: '/api/sessions/demo-1/events' });
    expect(events.json()).toHaveLength(15);
  });

  it('夹带非法事件 → rejected 计数，合法照常接受', async () => {
    const bad = { ...demoSession[0], id: 'bad-1' };
    delete (bad as Record<string, unknown>).sessionId;
    const res = await post([bad, { ...demoSession[0], id: 'dup-check-1', ts: 99_999, sessionId: 'demo-1' }]);
    expect(res.json()).toEqual({ accepted: 1, rejected: 1 });
  });

  it('非法 sessionId（路径穿越）被拒绝', async () => {
    const res = await post([{ ...demoSession[0], id: 'evil-1', sessionId: '../evil' }]);
    expect(res.json()).toEqual({ accepted: 0, rejected: 0 });
  });

  it('sessions 列表与 graph 接口', async () => {
    const sessions = (await ctx.app.inject({ method: 'GET', url: '/api/sessions' })).json();
    const demo = sessions.find((s: { sessionId: string }) => s.sessionId === 'demo-1');
    expect(demo.title).toContain('登录页');
    expect(demo.eventCount).toBe(16); // 15 + dup-check-1
    expect(demo.status).toBe('live');

    const graph = await ctx.app.inject({ method: 'GET', url: '/api/sessions/demo-1/graph' });
    expect(graph.statusCode).toBe(200);
    expect(graph.json().nodes.length).toBeGreaterThanOrEqual(11);

    const missing = await ctx.app.inject({ method: 'GET', url: '/api/sessions/nope/graph' });
    expect(missing.statusCode).toBe(404);
  });

  it('健康检查', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/api/health' });
    expect(res.json()).toEqual({ ok: true });
  });
});

describe('WebSocket 广播', () => {
  it('连接收到 hello；新事件推 event+graph；turn_end 推 session-end', async () => {
    await ctx.app.listen({ port: 0, host: '127.0.0.1' });
    const addr = ctx.app.server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);

    // 消息先入队，nextMessage 优先消费队列，避免 open/message 事件顺序竞态
    const queue: WsServerMessage[] = [];
    let waiter: ((m: WsServerMessage) => void) | null = null;
    ws.on('message', (raw) => {
      const msg = JSON.parse(String(raw)) as WsServerMessage;
      if (waiter) {
        const w = waiter;
        waiter = null;
        w(msg);
      } else {
        queue.push(msg);
      }
    });
    const nextMessage = (): Promise<WsServerMessage> =>
      queue.length > 0 ? Promise.resolve(queue.shift()!) : new Promise((resolve) => (waiter = resolve));
    await new Promise((r) => ws.once('open', r));

    const hello = await nextMessage();
    expect(hello.type).toBe('hello');
    if (hello.type === 'hello') expect(hello.sessions.length).toBeGreaterThan(0);

    await post([
      { ...demoSession[1], id: 'ws-plan-1', ts: 100_000, sessionId: 'demo-ws', adapter: 'demo' },
      { ...demoSession[14], id: 'ws-end-1', ts: 100_500, sessionId: 'demo-ws', adapter: 'demo' },
    ]);

    const ev1 = await nextMessage();
    expect(ev1.type).toBe('event');
    if (ev1.type === 'event') {
      expect(ev1.event.id).toBe('ws-end-1'); // 最后接受的一条
      expect(ev1.graph.sessionId).toBe('demo-ws');
    }
    const ev2 = await nextMessage();
    expect(ev2.type).toBe('session-end');
    if (ev2.type === 'session-end') expect(ev2.sessionId).toBe('demo-ws');

    ws.close();
    await ctx.app.close(); // 结束 listen，回到 inject 模式
  }, 20000);
});

describe('重启恢复', () => {
  it('新 SessionStore 指向同一 dataDir 仍能读出会话', () => {
    const store2 = new SessionStore(ctx.store.dataDir);
    const summaries = store2.summaries();
    expect(summaries.some((s) => s.sessionId === 'demo-1')).toBe(true);
    expect(store2.get('demo-1')).toHaveLength(16);
  });
});
