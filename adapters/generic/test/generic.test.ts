import { mkdtempSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AgentEvent } from '@agent-flow/protocol';
import { mapGenericLine, startGenericWatcher } from '../src/index.js';

const waitFor = async (fn: () => boolean, timeoutMs = 5000): Promise<void> => {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timeout');
    await new Promise((r) => setTimeout(r, 100));
  }
};

describe('mapGenericLine', () => {
  it('合法行 → generic 事件，sessionId 兜底为文件名', () => {
    const ev = mapGenericLine({ phase: 'tool_start', title: '读取 a.ts', tool: 'Read', files: ['a.ts'] }, 'sess1.jsonl', 1);
    expect(ev!.adapter).toBe('generic');
    expect(ev!.sessionId).toBe('sess1');
    expect(ev!.tool).toBe('Read');
  });

  it('缺 phase 或缺 title → null', () => {
    expect(mapGenericLine({ title: 'x' }, 's.jsonl', 1)).toBeNull();
    expect(mapGenericLine({ phase: 'note' }, 's.jsonl', 1)).toBeNull();
  });

  it('非法 phase 值被 schema 拒绝', () => {
    expect(mapGenericLine({ phase: 'thinking-hard', title: 'x' }, 's.jsonl', 1)).toBeNull();
  });

  it('自带 id/ts/sessionId 时保留', () => {
    const ev = mapGenericLine({ phase: 'note', title: 'x', id: 'my-id', ts: 123, sessionId: 'mine' }, 's.jsonl', 1);
    expect(ev!.id).toBe('my-id');
    expect(ev!.ts).toBe(123);
    expect(ev!.sessionId).toBe('mine');
  });
});

describe('generic watcher', () => {
  it('合法行出事件、非法行跳过、增量不重读', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'af-generic-'));
    const file = join(dir, 'any-agent.jsonl');
    writeFileSync(
      file,
      [
        JSON.stringify({ phase: 'user_prompt', title: '用户：干活' }),
        JSON.stringify({ not: 'valid' }),
        JSON.stringify({ phase: 'tool_start', tool: 'Bash', title: '执行 npm test' }),
        '',
      ].join('\n')
    );

    const events: AgentEvent[] = [];
    const watcher = startGenericWatcher({ dir, onEvent: (ev) => events.push(ev) });
    await waitFor(() => events.length >= 2);
    expect(events.map((e) => e.title)).toEqual(['用户：干活', '执行 npm test']);

    appendFileSync(file, JSON.stringify({ phase: 'turn_end', title: '完成' }) + '\n');
    await waitFor(() => events.length >= 3);
    expect(events).toHaveLength(3);
    await watcher.stop();
  }, 12000);
});
