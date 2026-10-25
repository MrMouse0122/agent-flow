import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { extname, join, resolve, dirname } from 'node:path';
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

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.json': 'application/json',
  '.map': 'application/json',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

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

  // 静态托管 web 构建产物（存在才启用；目录或未命中路径回退 index.html —— SPA）
  const webDist = resolve(dirname(fileURLToPath(import.meta.url)), '../../web/dist');
  if (existsSync(webDist)) {
    app.setNotFoundHandler(async (req, reply) => {
      const rel = req.url.split('?')[0] ?? '/';
      let filePath = resolve(webDist, '.' + (rel === '/' ? '/index.html' : rel));
      if (!filePath.startsWith(webDist)) return reply.code(404).send('not found');
      if (!existsSync(filePath) || !statSync(filePath).isFile()) {
        filePath = join(webDist, 'index.html'); // SPA 回退
      }
      if (!existsSync(filePath) || !statSync(filePath).isFile()) return reply.code(404).send('not found');
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
