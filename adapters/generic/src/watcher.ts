import { closeSync, openSync, readSync, statSync } from 'node:fs';
import { request } from 'node:http';
import chokidar from 'chokidar';
import { agentEventSchema, type AgentEvent } from '@agent-flow/protocol';

export interface GenericWatcherOptions {
  dir: string;
  port?: number;
  onEvent?: (ev: AgentEvent) => void;
}

export interface WatcherHandle {
  stop: () => Promise<void>;
}

/**
 * 通用兜底 adapter 的行映射约定：
 * 每行 JSON 是一个「准 AgentEvent」——必须有 title 和 phase；
 * sessionId 缺省取文件名，id 缺省自动生成，ts 缺省取当前时间，adapter 强制 generic。
 * 非法行直接跳过（不炸 watcher）。
 */
export function mapGenericLine(
  rec: unknown,
  fileName: string,
  lineNo: number,
  now = Date.now()
): AgentEvent | null {
  if (!rec || typeof rec !== 'object') return null;
  const r = rec as Record<string, unknown>;
  if (typeof r.title !== 'string' || !r.title) return null;
  if (typeof r.phase !== 'string') return null;

  const sessionId =
    typeof r.sessionId === 'string' && r.sessionId ? r.sessionId : fileName.replace(/\.jsonl$/i, '');
  const ev: AgentEvent = {
    id: typeof r.id === 'string' && r.id ? r.id : `generic:${sessionId}:${lineNo}`,
    ts: typeof r.ts === 'number' ? r.ts : now,
    sessionId,
    adapter: 'generic',
    phase: r.phase as AgentEvent['phase'],
    title: r.title,
    ...(typeof r.tool === 'string' ? { tool: r.tool } : {}),
    ...(Array.isArray(r.files) ? { files: r.files.filter((f): f is string => typeof f === 'string') } : {}),
    ...(r.input !== undefined ? { input: r.input } : {}),
    ...(r.output !== undefined ? { output: r.output } : {}),
    ...(Array.isArray(r.planItems) ? { planItems: r.planItems.filter((p): p is string => typeof p === 'string') } : {}),
    ...(r.status === 'ok' || r.status === 'error' ? { status: r.status } : {}),
  };
  return agentEventSchema.safeParse(ev).success ? ev : null;
}

function postEvent(ev: AgentEvent, port: number): void {
  const body = JSON.stringify({ events: [ev] });
  const req = request(
    {
      host: '127.0.0.1',
      port,
      path: '/api/events',
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
      timeout: 800,
    },
    (res) => res.resume()
  );
  req.on('error', () => {});
  req.on('timeout', () => req.destroy());
  req.end(body);
}

/** 监视 dir 下 *.jsonl 的增量追加（与 codex watcher 相同的 offset/半行缓冲机制）。 */
export function startGenericWatcher(opts: GenericWatcherOptions): WatcherHandle {
  const port = opts.port ?? Number(process.env.AGENT_FLOW_PORT ?? 4765);
  const emit = (ev: AgentEvent) => (opts.onEvent ? opts.onEvent(ev) : postEvent(ev, port));

  const offsets = new Map<string, number>();
  const partials = new Map<string, string>();
  const lineNos = new Map<string, number>();

  const tailFile = (file: string) => {
    try {
      const st = statSync(file);
      const prev = offsets.get(file) ?? 0;
      if (st.size < prev) {
        offsets.set(file, 0);
        partials.set(file, '');
        return;
      }
      if (st.size === prev) return;
      const fd = openSync(file, 'r');
      const buf = Buffer.alloc(st.size - prev);
      readSync(fd, buf, 0, buf.length, prev);
      closeSync(fd);
      offsets.set(file, st.size);

      const fileName = file.split(/[\\/]/).pop() ?? 'session';
      const text = (partials.get(file) ?? '') + buf.toString('utf8');
      const lines = text.split('\n');
      partials.set(file, lines.pop() ?? '');
      let no = lineNos.get(file) ?? 0;
      for (const line of lines) {
        no += 1;
        const trimmed = line.trim();
        if (!trimmed) continue;
        let rec: unknown;
        try {
          rec = JSON.parse(trimmed);
        } catch {
          continue;
        }
        const ev = mapGenericLine(rec, fileName, no);
        if (ev) emit(ev);
      }
      lineNos.set(file, no);
    } catch {
      // 下次再试
    }
  };

  const watcher = chokidar.watch(opts.dir, {
    persistent: true,
    usePolling: true,
    interval: 150,
    awaitWriteFinish: { stabilityThreshold: 150, pollInterval: 50 },
  });
  const onFile = (f: string) => {
    if (f.endsWith('.jsonl')) tailFile(f);
  };
  watcher.on('add', onFile);
  watcher.on('change', onFile);

  return { stop: () => watcher.close() };
}
