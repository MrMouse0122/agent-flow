import { z } from 'zod';
import type { AgentEvent } from './types.js';

export const adapterIdSchema = z.enum(['zcode', 'codex', 'ds-harness', 'generic', 'demo']);

export const agentEventSchema = z
  .object({
    id: z.string().min(1),
    ts: z.number().int().nonnegative(),
    sessionId: z.string().min(1),
    adapter: adapterIdSchema,
    phase: z.enum(['user_prompt', 'plan', 'tool_start', 'tool_end', 'turn_end', 'note']),
    tool: z.string().optional(),
    title: z.string().min(1),
    files: z.array(z.string()).optional(),
    input: z.unknown().optional(),
    output: z.unknown().optional(),
    planItems: z.array(z.string().min(1)).optional(),
    status: z.enum(['ok', 'error']).optional(),
    raw: z.unknown().optional(),
  })
  .passthrough();

export function parseAgentEvent(value: unknown): AgentEvent {
  return agentEventSchema.parse(value) as AgentEvent;
}

export function isAgentEvent(value: unknown): value is AgentEvent {
  return agentEventSchema.safeParse(value).success;
}

const TRUNCATE_SUFFIX = '…[truncated]';
const MAX_STR = 2000;
const MAX_ARRAY = 50;
const MAX_DEPTH = 6;

/**
 * 深截断：入库/广播前对 input/output/raw 做体积限制。
 * 长字符串、超长数组、深嵌套、循环引用都被安全处理，返回全新结构。
 */
export function truncateDeep(value: unknown, maxStr = MAX_STR): unknown {
  const seen = new WeakSet<object>();
  const walk = (v: unknown, depth: number): unknown => {
    if (typeof v === 'string') {
      return v.length > maxStr ? v.slice(0, maxStr) + TRUNCATE_SUFFIX : v;
    }
    if (v === null || typeof v !== 'object') return v;
    if (seen.has(v as object)) return '[Circular]';
    if (depth >= MAX_DEPTH) return '[MaxDepth]';
    seen.add(v as object);
    if (Array.isArray(v)) {
      const items = v.slice(0, MAX_ARRAY).map((item) => walk(item, depth + 1));
      if (v.length > MAX_ARRAY) items.push(`[+${v.length - MAX_ARRAY} more]`);
      return items;
    }
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      out[k] = walk(val, depth + 1);
    }
    return out;
  };
  return walk(value, 0);
}

/** 事件入库前的统一清洗：截断大字段 */
export function sanitizeEvent(event: AgentEvent): AgentEvent {
  return {
    ...event,
    input: truncateDeep(event.input),
    output: truncateDeep(event.output),
    raw: truncateDeep(event.raw),
  };
}
