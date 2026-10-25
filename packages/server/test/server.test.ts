import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { demoSession, type AgentEvent, type WsServerMessage } from '@agent-flow/protocol';
import { createApp, resolveWithin, type AppContext } from '../src/index.js';
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

describe('乱序时间戳', () => {
  it('晚到但 ts 更早的事件：firstTs/lastTs 取全量极值，不会出现 lastTs < firstTs', async () => {
    const store = new SessionStore(mkdtempSync(join(tmpdir(), 'agent-flow-oo-')));
    const mk = (id: string, ts: number, phase: AgentEvent['phase'] = 'note') => ({
      id,
      ts,
      sessionId: 'oo-1',
      adapter: 'demo' as const,
      phase,
      title: id,
    });
    store.append([mk('oo-a', 5_000_000_000_000), mk('oo-b', 5_000_000_100_000)]);
    // 补传一条一年前的旧事件（真实案例：客户端时钟偏差/离线回灌）
    store.append([mk('oo-c', 1_000_000_000_000, 'turn_end')]);

    const s = store.summaries().find((x) => x.sessionId === 'oo-1')!;
    expect(s.firstTs).toBe(1_000_000_000_000);
    expect(s.lastTs).toBe(5_000_000_100_000);
    expect(s.lastTs).toBeGreaterThanOrEqual(s.firstTs);
    // 补传的旧事件仍按 ts 归位到事件流开头
    expect(store.get('oo-1')!.map((e) => e.id)).toEqual(['oo-c', 'oo-a', 'oo-b']);
  });
});

describe('静态托管安全与编码', () => {
  // WS 广播用例会 close 共享的 ctx.app；这里单独起一个实例做 HTTP 静态断言
  let app2: AppContext;
  beforeAll(async () => {
    app2 = await createApp({ dataDir: mkdtempSync(join(tmpdir(), 'agent-flow-static-')), port: 0 });
  });
  afterAll(async () => {
    await app2.close();
  });

  it('index.html 可访问且带 charset', async () => {
    const res = await app2.app.inject({ method: 'GET', url: '/' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('charset=utf-8');
  });

  it('路径穿越被拒绝（编码与非编码形态）', async () => {
    // 注意：fastify.inject(light-my-request) 会在客户端把 /.. 规范化掉，
    // 裸 .. 形态到不了处理器 —— 穿越逻辑直接对 resolveWithin 做单元断言。
    const dist = resolve(dirname(fileURLToPath(import.meta.url)), '../../web/dist');
    expect(resolveWithin(dist, '/../package.json')).toBeNull();
    expect(resolveWithin(dist, '/../../tsconfig.base.json')).toBeNull();
    expect(resolveWithin(dist, '/..%2Fpackage.json')).toBeNull();
    expect(resolveWithin(dist, '/%2e%2e%2fpackage.json')).toBeNull();
    expect(resolveWithin(dist, '/%ff')).toBeNull(); // 坏编码不抛异常、直接拒绝

    // inject 能模拟的编码形态：不许带出 dist 外的内容
    for (const url of ['/%2e%2e%2fpackage.json', '/..%2Fpackage.json']) {
      const res = await app2.app.inject({ method: 'GET', url });
      if (res.statusCode === 200) {
        expect(String(res.payload), url).not.toContain('workspaces');
      } else {
        expect(res.statusCode, url).toBe(404);
      }
    }
  });

  it('SPA 回退：未知路径返回 index.html', async () => {
    const res = await app2.app.inject({ method: 'GET', url: '/some/spa/route' });
    expect(res.statusCode).toBe(200);
    expect(res.payload).toContain('<div id="root">');
  });
});

describe('会话删除', () => {
  let app3: AppContext;
  beforeAll(async () => {
    app3 = await createApp({ dataDir: mkdtempSync(join(tmpdir(), 'agent-flow-del-')), port: 0 });
  });
  afterAll(async () => {
    await app3.close();
  });

  it('DELETE 已有会话 → ok、列表与磁盘文件都消失；再删 → 404', async () => {
    const ev = { ...demoSession[0]!, id: 'del-1', ts: 1000, sessionId: 'del-target' };
    await app3.app.inject({ method: 'POST', url: '/api/events', payload: { events: [ev] } });
    const file = join(app3.store.dataDir, 'sessions', 'del-target.jsonl');
    expect(existsSync(file)).toBe(true);

    const del = await app3.app.inject({ method: 'DELETE', url: '/api/sessions/del-target' });
    expect(del.statusCode).toBe(200);
    expect(del.json()).toEqual({ ok: true });
    expect(existsSync(file)).toBe(false);
    expect(app3.store.summaries().some((s) => s.sessionId === 'del-target')).toBe(false);

    const again = await app3.app.inject({ method: 'DELETE', url: '/api/sessions/del-target' });
    expect(again.statusCode).toBe(404);

    // 删除后同名会话可重新开始（幂等去重集也一并清掉）
    const re = await app3.app.inject({ method: 'POST', url: '/api/events', payload: { events: [ev] } });
    expect(re.json()).toEqual({ accepted: 1, rejected: 0 });
  });
});
