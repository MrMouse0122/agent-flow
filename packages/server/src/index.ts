import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { extname, join, relative, resolve, dirname, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify, { type FastifyInstance } from 'fastify';
import { WebSocket, WebSocketServer, type WebSocket as WsSocket } from 'ws';
import { agentEventSchema, type AgentEvent, type Graph, type WsServerMessage } from '@agent-flow/protocol';
import { buildGraph } from '@agent-flow/inference';
import { SessionStore } from './store.js';

export interface AppOptions {
  port?: number;
  host?: string;
  dataDir?: string;
  computeGraph?: (events: AgentEvent[]) => Graph;
}

export interface AppContext {
  app: FastifyInstance;
  store: SessionStore;
  port: number;
  close: () => Promise<void>;
}

// 所有文本类型显式声明 charset=utf-8：部分国产/兼容内核浏览器在响应头缺 charset 时
// 会按系统本地编码（GBK）解码 JS/CSS，导致界面中文全部乱码（å·²è¿žæŽ¥ 这类）
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

/**
 * 把 URL path 解析为 root 内的绝对路径；带编码解码。
 * 逃出 root（..、绝对路径、坏编码）返回 null —— 静态服务的唯一入口，防路径穿越。
 */
export function resolveWithin(root: string, rel: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(rel);
  } catch {
    return null;
  }
  const abs = resolve(root, '.' + (decoded === '/' ? '/index.html' : decoded));
  // 归属校验用 relative 而非 startsWith：后者会被同级目录名（webDistX）或大小写差异绕过
  const relToRoot = relative(root, abs);
  if (relToRoot.startsWith('..') || isAbsolute(relToRoot)) return null;
  return abs;
}

export async function createApp(opts: AppOptions = {}): Promise<AppContext> {
  const port = opts.port ?? Number(process.env.AGENT_FLOW_PORT ?? 4765);
  const dataDir = opts.dataDir ?? process.env.AGENT_FLOW_HOME ?? join(homedir(), '.agent-flow');
  const store = new SessionStore(dataDir);
  const computeGraph = opts.computeGraph ?? ((events: AgentEvent[]) => buildGraph(events));

  const app = Fastify({ logger: false });
  const clients = new Set<WsSocket>();

  const broadcast = (msg: WsServerMessage) => {
    const data = JSON.stringify(msg);
    for (const ws of clients) {
      try {
        if (ws.readyState === WebSocket.OPEN) ws.send(data);
      } catch {
        clients.delete(ws);
      }
    }
  };
  const broadcastSessions = () => broadcast({ type: 'sessions', sessions: store.summaries() });

  app.get('/api/health', async () => ({ ok: true }));

  app.post('/api/events', async (req, reply) => {
    const body = req.body as { events?: unknown[] } | undefined;
    const incoming = Array.isArray(body?.events) ? body!.events! : [];
    const valid: AgentEvent[] = [];
    let rejected = 0;
    for (const item of incoming) {
      const parsed = agentEventSchema.safeParse(item);
      if (parsed.success) valid.push(parsed.data as AgentEvent);
      else rejected += 1;
    }
    const accepted = store.append(valid);

    // 按会话聚合广播：event 取该会话最后接受的一条，graph 为该会话最新图
    const lastBySession = new Map<string, AgentEvent>();
    for (const ev of accepted) lastBySession.set(ev.sessionId, ev);
    for (const [sessionId, lastEv] of lastBySession) {
      broadcast({
        type: 'event',
        event: lastEv,
        graph: computeGraph(store.get(sessionId) ?? []),
      });
      if (lastEv.phase === 'turn_end') broadcast({ type: 'session-end', sessionId });
    }
    if (accepted.length > 0) broadcastSessions();

    return reply.code(202).send({ accepted: accepted.length, rejected });
  });

  app.get('/api/sessions', async () => store.summaries());

  app.get('/api/sessions/:id/events', async (req, reply) => {
    const { id } = req.params as { id: string };
    const events = store.get(id);
    if (!events) return reply.code(404).send({ error: 'session not found' });
    return events;
  });

  app.get('/api/sessions/:id/graph', async (req, reply) => {
    const { id } = req.params as { id: string };
    const events = store.get(id);
    if (!events) return reply.code(404).send({ error: 'session not found' });
    return computeGraph(events);
  });

  // 删除会话（误报的冒烟数据、演示会话清理用）。删掉后广播新列表，在线面板即时消失。
  app.delete('/api/sessions/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!store.remove(id)) return reply.code(404).send({ error: 'session not found' });
    broadcastSessions();
    return { ok: true };
  });

  // 静态托管 web 构建产物（存在才启用；目录或未命中路径回退 index.html —— SPA）
  const webDist = resolve(dirname(fileURLToPath(import.meta.url)), '../../web/dist');
  if (existsSync(webDist)) {
    const isFile = (p: string): boolean => {
      try {
        return existsSync(p) && statSync(p).isFile();
      } catch {
        return false; // 悬空符号链接 / 权限问题等一律按不存在处理
      }
    };
    app.setNotFoundHandler(async (req, reply) => {
      const target = resolveWithin(webDist, req.url.split('?')[0] ?? '/');
      if (!target) return reply.code(404).send('not found');
      let filePath = target;
      if (!isFile(filePath)) {
        filePath = join(webDist, 'index.html'); // SPA 回退
      }
      if (!isFile(filePath)) return reply.code(404).send('not found');
      reply.header('content-type', MIME[extname(filePath).toLowerCase()] ?? 'application/octet-stream');
      return reply.send(readFileSync(filePath));
    });
  }

  await app.ready();
  const wss = new WebSocketServer({ noServer: true });
  app.server.on('upgrade', (req, socket, head) => {
    const { pathname } = new URL(req.url ?? '/', 'http://localhost');
    if (pathname !== '/ws') {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      clients.add(ws);
      try {
        ws.send(JSON.stringify({ type: 'hello', sessions: store.summaries() } satisfies WsServerMessage));
      } catch {
        /* 忽略 */
      }
      ws.on('close', () => clients.delete(ws));
      ws.on('error', () => clients.delete(ws));
    });
  });

  return {
    app,
    store,
    port,
    close: async () => {
      for (const ws of clients) ws.terminate();
      clients.clear();
      wss.close();
      await app.close();
    },
  };
}

export async function startServer(opts: AppOptions = {}): Promise<AppContext> {
  const ctx = await createApp(opts);
  await ctx.app.listen({ port: ctx.port, host: opts.host ?? '127.0.0.1' });
  const addr = ctx.app.server.address();
  const shown = typeof addr === 'object' && addr ? addr.port : ctx.port;
  console.log(`AgentFlow listening on http://127.0.0.1:${shown}`);
  return ctx;
}
