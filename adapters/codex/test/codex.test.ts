import { mkdtempSync, appendFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import type { AgentEvent } from '@agent-flow/protocol';
import { mapCodexLine, startCodexWatcher } from '../src/index.js';

const requireCjs = createRequire(import.meta.url);
const { notifyToEvent } = requireCjs('../notify.cjs') as {
  notifyToEvent: (argvJson: string, now?: number) => Record<string, unknown> | null;
};

const waitFor = async (fn: () => boolean, timeoutMs = 5000): Promise<void> => {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timeout');
    await new Promise((r) => setTimeout(r, 100));
  }
};

describe('mapCodexLine', () => {
  it('turn complete → turn_end', () => {
    const ev = mapCodexLine({ type: 'agent_turn_complete', session_id: 'x' }, 's', 1);
    expect(ev!.phase).toBe('turn_end');
  });

  it('用户消息 → user_prompt（content 数组取文本）', () => {
    const ev = mapCodexLine({ role: 'user', content: [{ type: 'text', text: '帮我看看这个报错' }] }, 's', 2);
    expect(ev!.phase).toBe('user_prompt');
    expect(ev!.title).toBe('用户：帮我看看这个报错');
  });

  it('shell 调用 → Bash tool_end，title 带命令', () => {
    const ev = mapCodexLine({ name: 'shell', arguments: { command: 'npm test' } }, 's', 3);
    expect(ev!.phase).toBe('tool_end');
    expect(ev!.tool).toBe('Bash');
    expect(ev!.title).toBe('执行 npm test');
    expect(ev!.status).toBe('ok');
  });

  it('apply_patch → Edit 且提取 files', () => {
    const ev = mapCodexLine({ name: 'apply_patch', input: { file_path: 'src/x.ts' } }, 's', 4);
    expect(ev!.tool).toBe('Edit');
    expect(ev!.files).toEqual(['src/x.ts']);
  });

  it('带 error → status error；assistant 文本 → note；垃圾 → null', () => {
    expect(mapCodexLine({ name: 'shell', arguments: { command: 'x' }, error: 'boom' }, 's', 5)!.status).toBe('error');
    expect(mapCodexLine({ role: 'assistant', content: '我看下日志' }, 's', 6)!.phase).toBe('note');
    expect(mapCodexLine({ foo: 1 }, 's', 7)).toBeNull();
    expect(mapCodexLine('string', 's', 8)).toBeNull();
  });
});

describe('notify.cjs', () => {
  it('argv JSON → turn_end 事件；坏输入 → null', () => {
    const ev = notifyToEvent(JSON.stringify({ session_id: 'abc', 'turn-id': 3 }), 1000);
    expect(ev!.phase).toBe('turn_end');
    expect(ev!.sessionId).toBe('abc');
    expect(notifyToEvent('not json')).toBeNull();
  });
});

describe('会话 watcher 增量读取', () => {
  it('先 3 行 → 3 条事件；再追加 2 行 → 只多 2 条', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'af-codex-'));
    const file = join(dir, 'rollout-2026-10-25-abc.jsonl');
    writeFileSync(
      file,
      [
        JSON.stringify({ role: 'user', content: '修一下登录' }),
        JSON.stringify({ name: 'read_file', input: { file_path: 'a.ts' } }),
        JSON.stringify({ type: 'agent_turn_complete' }),
        '',
      ].join('\n')
    );

    const events: AgentEvent[] = [];
    const watcher = startCodexWatcher({ sessionsDir: dir, onEvent: (ev) => events.push(ev) });
    await waitFor(() => events.length >= 3);
    expect(events.map((e) => e.phase)).toEqual(['user_prompt', 'tool_end', 'turn_end']);

    appendFileSync(
      file,
      [JSON.stringify({ name: 'shell', arguments: { command: 'npm test' } }), JSON.stringify({ role: 'assistant', content: '好了' }), ''].join('\n')
    );
    await waitFor(() => events.length >= 5);
    expect(events).toHaveLength(5);
    expect(new Set(events.map((e) => e.id)).size).toBe(5); // 无重复
    await watcher.stop();
  }, 12000);

  it('半行（无换行）不触发事件，补齐换行后才触发', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'af-codex2-'));
    const file = join(dir, 'partial.jsonl');
    writeFileSync(file, JSON.stringify({ role: 'user', content: 'hi' })); // 无结尾换行

    const events: AgentEvent[] = [];
    const watcher = startCodexWatcher({ sessionsDir: dir, onEvent: (ev) => events.push(ev) });
    await new Promise((r) => setTimeout(r, 600));
    expect(events).toHaveLength(0); // 半行被缓冲

    appendFileSync(file, '\n');
    await waitFor(() => events.length >= 1);
    expect(events[0]!.phase).toBe('user_prompt');
    await watcher.stop();
  }, 12000);
});
