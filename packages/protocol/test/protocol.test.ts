import { describe, expect, it } from 'vitest';
import { agentEventSchema, demoSession, demoSession2, sanitizeEvent, truncateDeep } from '../src/index.js';

describe('agentEventSchema', () => {
  it('accepts every event in the demo fixtures', () => {
    for (const ev of [...demoSession, ...demoSession2]) {
      expect(agentEventSchema.safeParse(ev).success).toBe(true);
    }
  });

  it('rejects missing sessionId', () => {
    const bad = { ...demoSession[0] };
    delete (bad as Record<string, unknown>).sessionId;
    expect(agentEventSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects unknown phase', () => {
    expect(agentEventSchema.safeParse({ ...demoSession[0], phase: 'thinking-hard' }).success).toBe(false);
  });

  it('allows extra fields (passthrough for adapter-specific data)', () => {
    expect(agentEventSchema.safeParse({ ...demoSession[0], extraTopLevel: 1 }).success).toBe(true);
  });
});

describe('truncateDeep', () => {
  it('truncates long strings with a marker', () => {
    const out = truncateDeep('x'.repeat(5000)) as string;
    expect(out.length).toBeLessThanOrEqual(2015);
    expect(out.endsWith('…[truncated]')).toBe(true);
  });

  it('caps arrays and appends a count marker', () => {
    const out = truncateDeep({ items: Array.from({ length: 80 }, (_, i) => i) }) as { items: unknown[] };
    expect(out.items.length).toBe(51);
    expect(out.items.at(-1)).toBe('[+30 more]');
  });

  it('handles circular references without throwing', () => {
    const a: Record<string, unknown> = {};
    a.self = a;
    expect(truncateDeep(a)).toEqual({ self: '[Circular]' });
  });

  it('sanitizeEvent truncates input/output/raw but keeps identity fields', () => {
    const ev = { ...demoSession[0], input: 'y'.repeat(9999), raw: { blob: 'z'.repeat(9999) } };
    const out = sanitizeEvent(ev);
    expect((out.input as string).length).toBeLessThanOrEqual(2015);
    expect(((out.raw as { blob: string }).blob).length).toBeLessThanOrEqual(2015);
    expect(out.id).toBe(ev.id);
    expect(out.title).toBe(ev.title);
  });
});
