/**
 * 离线演示的纯调度逻辑（不依赖 DOM / inference，可单测）。
 * fixtures 里的 ts 是相对偏移，模拟器换算成真实时间并按倍速压缩间隔。
 */
import type { AgentEvent, SessionSummary } from '@agent-flow/protocol';

/**
 * 计算每个事件相对上一个事件的播放延迟（毫秒）。
 * delays[0] = 0（首事件立即播），delays[i] = (ts[i] - ts[i-1]) / speed，向下取 0。
 */
export function computeDemoDelays(events: AgentEvent[], speed: number): number[] {
  if (speed <= 0) throw new Error('speed 必须为正数');
  return events.map((ev, i) => {
    if (i === 0) return 0;
    return Math.max(0, (ev.ts - events[i - 1]!.ts) / speed);
  });
}

/** 把相对 ts 映射为真实时间轴：startTs + ts / speed */
export function mapDemoTimestamps(events: AgentEvent[], startTs: number, speed: number): AgentEvent[] {
  if (speed <= 0) throw new Error('speed 必须为正数');
  return events.map((ev) => ({ ...ev, ts: startTs + ev.ts / speed }));
}

/** 从事件数组推导会话摘要；upto 用于「已播放前缀」的实时视图 */
export function summarizeEvents(events: AgentEvent[], status: 'live' | 'ended', upto?: number): SessionSummary {
  const visible = upto === undefined ? events : events.slice(0, Math.max(0, upto));
  const first = events[0];
  const last = visible[visible.length - 1] ?? first;
  const prompt = events.find((e) => e.phase === 'user_prompt');
  return {
    sessionId: first?.sessionId ?? '(空)',
    adapter: first?.adapter ?? 'generic',
    firstTs: first?.ts ?? 0,
    lastTs: last?.ts ?? 0,
    title: prompt?.title ?? first?.title ?? first?.sessionId ?? '(空会话)',
    eventCount: visible.length,
    status,
  };
}
