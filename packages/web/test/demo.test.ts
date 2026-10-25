/** 离线演示调度器的纯逻辑单测 */
import { describe, expect, it } from 'vitest';
import { demoSession } from '@agent-flow/protocol';
import { computeDemoDelays, mapDemoTimestamps, summarizeEvents } from '../src/demoScheduler';

describe('computeDemoDelays', () => {
  it('按 ts 差 / 倍速 计算间隔，首事件为 0', () => {
    const delays = computeDemoDelays(demoSession, 4);
    expect(delays).toHaveLength(demoSession.length);
    expect(delays[0]).toBe(0);
    // demoSession 前两个事件 ts 差 2000ms，4x 加速后 500ms
    expect(delays[1]).toBe(500);
    // 全部非负且有限
    for (const d of delays) expect(d).toBeGreaterThanOrEqual(0);
    // 4x 播放总时长 ≈ (末事件 ts - 首事件 ts) / 4
    const total = delays.slice(1).reduce((a, b) => a + b, 0);
    expect(total).toBeCloseTo((demoSession[demoSession.length - 1]!.ts - demoSession[0]!.ts) / 4, 5);
  });

  it('相同 ts 的连续事件间隔为 0，非法速度抛错', () => {
    const evs = [
      { ...demoSession[0]!, ts: 100 },
      { ...demoSession[1]!, ts: 100 },
    ];
    expect(computeDemoDelays(evs, 1)).toEqual([0, 0]);
    expect(() => computeDemoDelays(evs, 0)).toThrow();
  });
});

describe('mapDemoTimestamps', () => {
  it('把相对偏移映射到真实时间轴并保持有序', () => {
    const start = 1_700_000_000_000;
    const mapped = mapDemoTimestamps(demoSession, start, 4);
    expect(mapped[0]!.ts).toBe(start);
    expect(mapped[1]!.ts).toBe(start + 2000 / 4);
    for (let i = 1; i < mapped.length; i++) {
      expect(mapped[i]!.ts).toBeGreaterThanOrEqual(mapped[i - 1]!.ts);
    }
    expect(mapped.every((e, i) => e.id === demoSession[i]!.id)).toBe(true);
  });
});

describe('summarizeEvents', () => {
  it('标题取首个 user_prompt，统计首末 ts 与数量', () => {
    const s = summarizeEvents(demoSession, 'ended');
    expect(s.sessionId).toBe(demoSession[0]!.sessionId);
    expect(s.adapter).toBe('demo');
    expect(s.title).toBe(demoSession[0]!.title);
    expect(s.firstTs).toBe(demoSession[0]!.ts);
    expect(s.lastTs).toBe(demoSession[demoSession.length - 1]!.ts);
    expect(s.eventCount).toBe(demoSession.length);
    expect(s.status).toBe('ended');
  });

  it('upto 前缀视图：直播开始前的摘要只有 0 个事件、lastTs 等于 firstTs', () => {
    const s = summarizeEvents(demoSession, 'live', 0);
    expect(s.eventCount).toBe(0);
    expect(s.lastTs).toBe(s.firstTs);
    expect(s.status).toBe('live');
  });

  it('upto=2 时 lastTs 与计数取前缀', () => {
    const s = summarizeEvents(demoSession, 'live', 2);
    expect(s.eventCount).toBe(2);
    expect(s.lastTs).toBe(demoSession[1]!.ts);
  });
});
