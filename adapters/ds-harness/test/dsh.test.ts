import { describe, expect, it } from 'vitest';
import { mapDshEvent } from '../plugin/mapper.js';

// fixture 事件形状参照 dsh 官方文档的会话事件表（{ seq, time, type, data }）
describe('mapDshEvent — 会话事件映射', () => {
  it('user/message → user_prompt，time 毫秒直通', () => {
    const ev = mapDshEvent({ seq: 3, time: 1792900000000, type: 'user/message', data: { text: '帮我看看这个报错' } }, 'sess-1');
    expect(ev!.phase).toBe('user_prompt');
    expect(ev!.title).toBe('用户：帮我看看这个报错');
    expect((ev!.input as { prompt: string }).prompt).toBe('帮我看看这个报错');
    expect(ev!.id).toBe('dsh:sess-1:3');
    expect(ev!.ts).toBe(1792900000000);
    expect(ev!.adapter).toBe('ds-harness');
  });

  it('assistant/message → note；message/content 等别名也能取到文本', () => {
    expect(mapDshEvent({ seq: 4, time: 1, type: 'assistant/message', data: { text: '我看下日志' } }, 's')!.phase).toBe('note');
    expect(mapDshEvent({ seq: 5, time: 1, type: 'assistant/message', data: { message: '第二种形状' } }, 's')!.title).toContain('第二种形状');
  });

  it('tool/call → tool_start：arguments JSON 字符串解析，command 数组拼一行', () => {
    const ev = mapDshEvent(
      { seq: 6, time: '2026-10-25T12:00:00Z', type: 'tool/call', data: { tool: 'shell', arguments: JSON.stringify({ command: ['bash', '-lc', 'npm test'] }) } },
      's',
    );
    expect(ev!.phase).toBe('tool_start');
    expect(ev!.tool).toBe('shell');
    expect(ev!.title).toBe('执行 bash -lc npm test');
    expect(ev!.ts).toBe(Date.parse('2026-10-25T12:00:00Z'));
  });

  it('tool/call 带 file_path → files；tool/result → tool_end，error 判定', () => {
    const call = mapDshEvent({ seq: 7, time: 1, type: 'tool/call', data: { name: 'edit', input: { file_path: 'src/x.ts' } } }, 's');
    expect(call!.files).toEqual(['src/x.ts']);
    expect(call!.title).toContain('src/x.ts');

    const ok = mapDshEvent({ seq: 8, time: 1, type: 'tool/result', data: { tool: 'edit', result: 'applied' } }, 's');
    expect(ok!.phase).toBe('tool_end');
    expect(ok!.status).toBe('ok');
    const bad = mapDshEvent({ seq: 9, time: 1, type: 'tool/result', data: { tool: 'edit', error: 'boom' } }, 's');
    expect(bad!.status).toBe('error');
  });

  it('todo/write → plan 事件（字符串与对象条目都支持）', () => {
    const ev = mapDshEvent(
      { seq: 10, time: 1, type: 'todo/write', data: { todos: [{ content: '定位耗时环节', status: 'pending' }, '修复并验证'] } },
      's',
    );
    expect(ev!.phase).toBe('plan');
    expect(ev!.planItems).toEqual(['定位耗时环节', '修复并验证']);
    expect(ev!.title).toContain('2 项');
  });

  it('turn/end → turn_end；error/blocked/aborted 带失败状态', () => {
    expect(mapDshEvent({ seq: 11, time: 1, type: 'turn/end', data: { kind: 'completed' } }, 's')!.status).toBe('ok');
    const bad = mapDshEvent({ seq: 12, time: 1, type: 'turn/end', data: { kind: 'error' } }, 's');
    expect(bad!.status).toBe('error');
    expect(bad!.title).toContain('error');
  });

  it('turn/start、step/*、未知类型、坏输入 → null；缺 seq/time 有兜底不炸', () => {
    expect(mapDshEvent({ seq: 13, time: 1, type: 'turn/start' }, 's')).toBeNull();
    expect(mapDshEvent({ seq: 14, time: 1, type: 'step/start' }, 's')).toBeNull();
    expect(mapDshEvent({ seq: 15, time: 1, type: 'mystery/event' }, 's')).toBeNull();
    expect(mapDshEvent(null, 's')).toBeNull();
    const fallback = mapDshEvent({ type: 'user/message', data: { text: '无 seq/time' } }, 's', 12345);
    expect(fallback!.ts).toBe(12345);
    expect(fallback!.id).toBe('dsh:s:12345');
  });
});
