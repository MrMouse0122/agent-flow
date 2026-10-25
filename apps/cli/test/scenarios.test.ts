import { describe, expect, it } from 'vitest';
import { scenarios, skillScenario, validateScenario } from '../src/demoScenarios.js';

describe('demo 场景', () => {
  it('两个场景全部事件合法且 id 唯一', () => {
    for (const s of scenarios) {
      expect(validateScenario(s)).toEqual([]);
    }
  });

  it('skill 场景包含 AI 原话 note/why，且有失败与补救', () => {
    const evs = skillScenario.events('check');
    expect(evs.some((e) => e.phase === 'note' && typeof (e.input as { why?: unknown })?.why === 'string')).toBe(true);
    expect(evs.some((e) => e.phase === 'tool_end' && e.status === 'error')).toBe(true);
    expect(evs.at(-1)!.phase).toBe('turn_end');
  });
});
