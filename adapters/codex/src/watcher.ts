import { closeSync, openSync, readSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';
import chokidar from 'chokidar';
import type { AgentEvent } from '@agent-flow/protocol';

const cut = (s: string, n: number) => (s.length > n ? s.slice(0, n) + '…' : s);

const TOOL_ALIASES: Record<string, string> = {
  shell: 'Bash',
  bash: 'Bash',
  shell_command: 'Bash',
  exec: 'Bash',
  read_file: 'Read',
  apply_patch: 'Edit',
  edit_file: 'Edit',
  write_file: 'Write',
};

const normalizeTool = (name: string) => TOOL_ALIASES[name.toLowerCase()] ?? name;

function textOf(content: unknown): string | undefined {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const parts = content
      .map((c) => (typeof c === 'string' ? c : c && typeof c === 'object' && typeof (c as { text?: unknown }).text === 'string' ? (c as { text: string }).text : ''))
      .filter(Boolean);
    return parts.length ? parts.join('\n') : undefined;
  }
  return undefined;
}

/**
 * 把一行 Codex 会话日志映射为 AgentEvent。
 * 注意：行格式基于公开样例的假设实现（详见包 README），接真实 ~/.codex/sessions 后可能需要调整。
 * 工具调用一行给一个 tool_end（推理层支持孤立 end 建
 * 节点），避免臆造 start 时间。
 */
export function mapCodexLine(
  rec: unknown,
  sessionId: string,
  lineNo: number,
  now = Date.now()
): AgentEvent | null {
  if (!rec || typeof rec !== 'object') return null;
  const r = rec as Record<string, unknown>;
  const mk = (phase: AgentEvent['phase'], extra: Partial<AgentEvent>): AgentEvent => ({
    id: `codex:${sessionId}:${lineNo}`,
    ts: now,
    sessionId,
    adapter: 'codex',
    phase,
    title: '',
    ...extra,
  });

  const type = typeof r.type === 'string' ? r.type.toLowerCase() : '';
  if (type.includes('turn') && (type.includes('complete') || type.includes('end'))) {
    return mk('turn_end', { title: 'Codex 本轮完成' });
  }

  if (r.role === 'user' || type.endsWith('user_message')) {
    const text = textOf(r.content) ?? (typeof r.text === 'string' ? r.text : undefined);
    if (!text) return null;
    return mk('user_prompt', { title: '用户：' + cut(text, 60), input: { prompt: text } });
  }

  if (r.role === 'assistant' || type.endsWith('assistant_message')) {
    const text = textOf(r.content) ?? (typeof r.text === 'string' ? r.text : undefined);
    if (!text) return null;
    return mk('note', { title: cut(text, 60) });
  }

  const rawTool =
    typeof r.name === 'string' ? r.name : typeof r.tool === 'string' ? r.tool : type.includes('function') ? 'Bash' : undefined;
  if (rawTool) {
    const args = (r.arguments ?? r.input ?? r.args ?? r.parameters ?? {}) as Record<string, unknown>;
    const command = typeof args.command === 'string' ? args.command : undefined;
    const file =
      typeof args.file_path === 'string'
        ? args.file_path
        : typeof args.path === 'string'
          ? args.path
          : undefined;
    const tool = normalizeTool(rawTool);
    const title = command
      ? `执行 ${cut(command, 40)}`
      : file
        ? `${tool} ${cut(file, 60)}`
        : `调用 ${tool}`;
    return mk('tool_end', {
      tool,
      title,
      files: file ? [file] : undefined,
      input: Object.keys(args).length > 0 ? args : undefined,
      status: r.error ? 'error' : 'ok',
    });
  }
  return null;
}

export interface CodexWatcherOptions {
  sessionsDir?: string;
  port?: number;
  onEvent?: (ev: AgentEvent) => void;
}

export interface WatcherHandle {
  stop: () => Promise<void>;
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

/**
 * 监视 ~/.codex/sessions 下的全部 .jsonl（递归），增量读取（字节 offset + 半行缓冲 + 行号去重）。
 * 事件经 onEvent 回调（测试）或直接 POST 到 AgentFlow server（默认）。
 * Windows 上使用轮询模式，避开 libuv fs-event 的原生断言崩溃。
 */
export function startCodexWatcher(opts: CodexWatcherOptions = {}): WatcherHandle {
  const dir = opts.sessionsDir ?? join(homedir(), '.codex', 'sessions');
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
        offsets.set(file, 0); // 文件被截断/轮转 → 从头重读
        partials.set(file, '');
        return;
      }
      if (st.size === prev) return;
      const fd = openSync(file, 'r');
      const buf = Buffer.alloc(st.size - prev);
      readSync(fd, buf, 0, buf.length, prev);
      closeSync(fd);
      offsets.set(file, st.size);

      const sessionId = (file.split(/[\\/]/).pop() ?? 'codex').replace(/\.jsonl$/i, '');
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
        const ev = mapCodexLine(rec, sessionId, no);
        if (ev) emit(ev);
      }
      lineNos.set(file, no);
    } catch {
      // 文件正在轮转/被锁，下次再试
    }
  };

  const watcher = chokidar.watch(dir, {
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
