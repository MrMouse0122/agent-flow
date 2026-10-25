import { describe, expect, it } from 'vitest';
import { demoSession } from '@agent-flow/protocol';
import { buildGraph } from '@agent-flow/inference';
import { buildStory } from '../src/story';

describe('buildStory — 承接/结果/序号', () => {
  const events = demoSession;
  const story = buildStory(buildGraph(events), events);

  it('总结包含计划、失败补救与结论', () => {
    expect(story.summary).toContain('3 步');
    expect(story.summary).toContain('1 次失败');
    expect(story.summary).toContain('最终结论');
  });

  it('读→改：Edit 的承接说明指向读文件', () => {
    const edit = story.blocks.find((b) => b.step.id === 'n:demo:demo-1:007')!;
    expect(edit.connect).toBe('基于刚才读到的文件内容动手修改');
  });

  it('验证步骤的承接与结果：第一次测试失败展示错误摘要', () => {
    const badTest = story.blocks.find((b) => b.step.id === 'n:demo:demo-1:009')!;
    expect(badTest.connect).toBe('修改完成，立即验证效果');
    expect(badTest.result).toContain('2 failing');
    expect(badTest.step.status).toBe('error');
  });

  it('失败后的下一步标记补救，承接话术说明补救关系', () => {
    const fix = story.blocks.find((b) => b.step.id === 'n:demo:demo-1:011')!;
    expect(fix.remediation).toBe(true);
    expect(fix.connect).toBe('上一步失败了，这一步是针对失败的补救');
  });

  it('动作序号连续（工具+说明统一编号）', () => {
    const idx = story.blocks.map((b) => b.index).filter((n): n is number => typeof n === 'number');
    expect(idx).toEqual(idx.map((_, i) => i + 1));
  });

  it('计划分隔行带序号与动作数', () => {
    const plan0 = story.blocks.find((b) => b.step.id === 'plan:0') as { actionCount?: number; planIndex?: number };
    expect(plan0.planIndex).toBe(1);
    expect(plan0.actionCount).toBeGreaterThanOrEqual(1);
  });

  it('收尾节点承接话术为收尾总结', () => {
    const turn = story.blocks.find((b) => b.step.kind === 'turn-end')!;
    expect(turn.connect).toBe('所有步骤结束，收尾总结');
  });
});
