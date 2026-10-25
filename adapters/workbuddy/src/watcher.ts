import { closeSync, openSync, readdirSync, readFileSync, readSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';
import chokidar from 'chokidar';
import type { AgentEvent } from '@agent-flow/protocol';
import { mapAuditRecord, mapChangesDoc, readSidebarItems, type SidebarItem } from './mapper.js';

const readFileText = (p: string): string => readFileSync(p, 'utf8');

export interface WorkbuddyWatcherOptions {
  /** WorkBuddy 数据目录，默认 ~/.workbuddy */
  homeDir?: string;
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
 * 监视 WorkBuddy 的三类本机数据源并翻译成 AgentEvent：
 *  1. audit-log 目录下按天分文件的 .jsonl（追加式）→ 命令执行 / 文件读取 / 审批 / 敏感信息
 *  2. changes-index 目录下按会话命名的 .json（整文件重写）→ 写入/修改/删除文件（带路径与时间戳）
 *  3. 各 profile 目录的 sidebar-list-snapshot.json（整文件重写）→ 会话标题（合成 user_prompt）+ 空闲收尾（turn_end）
 * 所有事件 id 取自数据源自带标识，重启重读不会重复入库。
 */
export function startWorkbuddyWatcher(opts: WorkbuddyWatcherOptions = {}): WatcherHandle {
  const home = opts.homeDir ?? join(homedir(), '.workbuddy');
  const port = opts.port ?? Number(process.env.AGENT_FLOW_PORT ?? 4765);
  const emitRaw = (ev: AgentEvent) => (opts.onEvent ? opts.onEvent(ev) : postEvent(ev, port));

  // 每会话最早事件时间：给「会话标题」合成的 user_prompt 定位到时间线最前
  const firstTsBySession = new Map<string, number>();
  const emit = (ev: AgentEvent) => {
    const prev = firstTsBySession.get(ev.sessionId);
    if (prev === undefined || ev.ts < prev) firstTsBySession.set(ev.sessionId, ev.ts);
    emitRaw(ev);
  };

  // ---- 1. audit-log：JSONL 增量 tail（offset + 半行缓冲，按天分文件）----
  const offsets = new Map<string, number>();
  const partials = new Map<string, string>();
  const tailAudit = (file: string) => {
    try {
      const st = statSync(file);
      const prev = offsets.get(file) ?? 0;
      if (st.size < prev) {
        offsets.set(file, 0); // 被截断/轮转 → 从头重读（id 幂等，不会重复入库）
        partials.set(file, '');
        return;
      }
      if (st.size === prev) return;
      const fd = openSync(file, 'r');
      const buf = Buffer.alloc(st.size - prev);
      readSync(fd, buf, 0, buf.length, prev);
      closeSync(fd);
      offsets.set(file, st.size);

      const text = (partials.get(file) ?? '') + buf.toString('utf8');
      const lines = text.split('\n');
      partials.set(file, lines.pop() ?? '');
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        let rec: unknown;
        try {
          rec = JSON.parse(trimmed);
        } catch {
          continue;
        }
        const ev = mapAuditRecord(rec);
        if (ev) emit(ev);
      }
    } catch {
      // 文件正在轮转/被锁，下次再试
    }
  };

  // ---- 2. changes-index：整文件重写，按 change.id 去重后只发新增条目 ----
  const seenChanges = new Set<string>();
  const loadChanges = (file: string) => {
    try {
      const doc: unknown = JSON.parse(readFileText(file));
      for (const ev of mapChangesDoc(doc)) {
        const key = ev.id;
        if (seenChanges.has(key)) continue;
        seenChanges.add(key);
        emit(ev);
      }
    } catch {
      // 半写状态/权限问题，下次再试
    }
  };

  // ---- 3. sidebar 快照：会话标题（user_prompt）+ 状态转空闲（turn_end）----
  const titles = new Map<string, SidebarItem>();
  const announcedPrompt = new Set<string>();
  const lastState = new Map<string, string>();
  const loadSidebar = (file: string) => {
    let items: SidebarItem[];
    try {
      items = readSidebarItems(JSON.parse(readFileText(file)));
    } catch {
      return;
    }
    for (const item of items) {
      titles.set(item.sessionId, item);
      const prev = lastState.get(item.sessionId);
      lastState.set(item.sessionId, item.state);
      // 首次见到只记录状态，不产生事件（快照可能在会话中途才被读到）
      if (prev && prev !== 'idle' && item.state === 'idle') {
        emit({
          id: `wb:state:${item.sessionId}:${item.updatedAt}`,
          ts: item.updatedAt || Date.now(),
          sessionId: item.sessionId,
          adapter: 'workbuddy',
          phase: 'turn_end',
          title: 'WorkBuddy 会话转入空闲（本轮结束）',
          status: 'ok',
        });
      }
      // 标题合成 user_prompt：ts 取该会话最早事件之前，保证提问节点在时间线最前；
      // 标题来自 WorkBuddy 侧栏（产品对用户诉求的概括），input.source 如实标注来源
      if (!announcedPrompt.has(item.sessionId)) {
        announcedPrompt.add(item.sessionId);
        const firstTs = firstTsBySession.get(item.sessionId);
        const ts = firstTs !== undefined ? Math.min(firstTs - 1, item.updatedAt || firstTs - 1) : item.updatedAt || Date.now();
        emit({
          id: `wb:title:${item.sessionId}`,
          ts,
          sessionId: item.sessionId,
          adapter: 'workbuddy',
          phase: 'user_prompt',
          title: `用户：${item.title}`,
          input: { prompt: item.title, source: 'workbuddy-session-title' },
        });
      }
    }
  };

  const watcher = chokidar.watch([join(home, 'audit-log'), join(home, 'changes-index')], {
    persistent: true,
    usePolling: true,
    interval: 150,
    awaitWriteFinish: { stabilityThreshold: 150, pollInterval: 50 },
  });
  const onAudit = (f: string) => {
    if (f.endsWith('.jsonl')) tailAudit(f);
  };
  watcher.on('add', (f) => {
    if (/[\\/]audit-log[\\/]/.test(f)) onAudit(f);
    else if (/[\\/]changes-index[\\/]/.test(f)) loadChanges(f);
    else if (/sidebar-list-snapshot\.json$/.test(f)) loadSidebar(f);
  });
  watcher.on('change', (f) => {
    if (/[\\/]changes-index[\\/]/.test(f)) loadChanges(f);
    else if (/sidebar-list-snapshot\.json$/.test(f)) loadSidebar(f);
    else if (/[\\/]audit-log[\\/]/.test(f)) onAudit(f);
  });

  // chokidar v4 不支持 glob：profile 目录（sidebar 快照所在）改为显式发现 + 定时重扫
  const snapshotPaths = new Set<string>();
  const scanSnapshots = () => {
    let candidates: string[];
    try {
      candidates = readdirSync(home, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => join(home, e.name, 'sidebar-list-snapshot.json'));
    } catch {
      return;
    }
    for (const p of candidates) {
      if (snapshotPaths.has(p)) continue;
      snapshotPaths.add(p);
      void watcher.add(p);
      loadSidebar(p); // 快照已存在时立即读一次，不等 chokidar 事件
    }
  };
  scanSnapshots();
  const rescanTimer = setInterval(scanSnapshots, 5000);

  return {
    stop: async () => {
      clearInterval(rescanTimer);
      await watcher.close();
    },
  };
}
