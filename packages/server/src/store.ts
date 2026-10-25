import { appendFileSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { sanitizeEvent, type AgentEvent, type SessionSummary } from '@agent-flow/protocol';

const SESSION_ID_RE = /^[A-Za-z0-9._-]+$/;

/** 防路径穿越：sessionId 只允许安全字符集 */
export const isValidSessionId = (id: string): boolean => SESSION_ID_RE.test(id);

interface SessionState {
  events: AgentEvent[];
  ended: boolean;
}

const trunc = (s: string, n: number) => (s.length > n ? s.slice(0, n) + '…' : s);

/**
 * 会话存储：append-only JSONL（<dataDir>/sessions/<sessionId>.jsonl）+ 内存索引。
 * server 重启时全量重放目录，会话列表不丢。
 */
export class SessionStore {
  private sessions = new Map<string, SessionState>();
  private seenIds = new Map<string, Set<string>>();

  constructor(public readonly dataDir: string) {
    const dir = join(dataDir, 'sessions');
    mkdirSync(dir, { recursive: true });
    for (const f of readdirSync(dir)) {
      if (!f.endsWith('.jsonl')) continue;
      const id = f.slice(0, -'.jsonl'.length);
      if (!isValidSessionId(id)) continue;
      let lines: string[] = [];
      try {
        lines = readFileSync(join(dir, f), 'utf8').split('\n').filter(Boolean);
      } catch {
        continue;
      }
      const st: SessionState = { events: [], ended: false };
      const seen = new Set<string>();
      for (const line of lines) {
        try {
          const ev = JSON.parse(line) as AgentEvent;
          if (seen.has(ev.id)) continue;
          seen.add(ev.id);
          st.events.push(ev);
          st.ended = ev.phase === 'turn_end';
        } catch {
          // 坏行跳过，不影响其余事件
        }
      }
      this.sessions.set(id, st);
      this.seenIds.set(id, seen);
    }
  }

  /** 追加事件：按 id 幂等去重、截断大字段后落盘。返回真正接受的事件。 */
  append(events: AgentEvent[]): AgentEvent[] {
    const accepted: AgentEvent[] = [];
    for (const raw of events) {
      if (!isValidSessionId(raw.sessionId)) continue;
      let seen = this.seenIds.get(raw.sessionId);
      if (!seen) {
        seen = new Set<string>();
        this.seenIds.set(raw.sessionId, seen);
      }
      if (seen.has(raw.id)) continue;
      seen.add(raw.id);
      const ev = sanitizeEvent(raw);
      let st = this.sessions.get(ev.sessionId);
      if (!st) {
        st = { events: [], ended: false };
        this.sessions.set(ev.sessionId, st);
      }
      st.events.push(ev);
      st.ended = ev.phase === 'turn_end'; // turn_end 之后又来事件 → 翻回 live
      appendFileSync(join(this.dataDir, 'sessions', `${ev.sessionId}.jsonl`), JSON.stringify(ev) + '\n');
      accepted.push(ev);
    }
    return accepted;
  }

  /** 事件副本（按 ts 升序）；未知会话返回 null */
  get(sessionId: string): AgentEvent[] | null {
    const st = this.sessions.get(sessionId);
    return st ? [...st.events].sort((a, b) => a.ts - b.ts) : null;
  }

  summaries(): SessionSummary[] {
    return [...this.sessions.entries()]
      .map(([sessionId, st]) => {
        const first = st.events[0]!;
        const last = st.events.at(-1)!;
        const prompt = st.events.find((e) => e.phase === 'user_prompt');
        const promptText =
          prompt && typeof (prompt.input as { prompt?: unknown } | undefined)?.prompt === 'string'
            ? (prompt.input as { prompt: string }).prompt
            : undefined;
        const title = prompt ? trunc(promptText ?? prompt.title, 60) : sessionId;
        return {
          sessionId,
          adapter: first.adapter,
          firstTs: first.ts,
          lastTs: last.ts,
          title,
          eventCount: st.events.length,
          status: st.ended ? ('ended' as const) : ('live' as const),
        };
      })
      .sort((a, b) => b.firstTs - a.firstTs);
  }
}
