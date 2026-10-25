import { describe, expect, it } from 'vitest';
import { demoSession } from '@agent-flow/protocol';
import { buildGraph } from '../src/index.js';
import type { AgentEvent } from '@agent-flow/protocol';

const ev = (partial: Partial<AgentEvent> & { id: string; ts: number; phase: AgentEvent['phase']; title: string }): AgentEvent => ({
  sessionId: 's1',
  adapter: 'demo',
  ...partial,
} as AgentEvent);

const node = (g: ReturnType<typeof buildGraph>, id: string) => g.nodes.find((n) => n.id === id);
const edgeKinds = (g: ReturnType<typeof buildGraph>, to: string) => g.edges.filter((e) => e.to === to).map((e) => e.kind);

describe('buildGraph — demoSession 全量断言', () => {
  const g = buildGraph(demoSession);

  it('节点总数 = 1 prompt + 3 plan + 6 工具 + 1 turn-end', () => {
    expect(g.nodes).toHaveLength(11);
    expect(g.sessionId).toBe('demo-1');
  });

  it('工具配对：6 个工具节点，失败的 npm test 是 error', () => {
    const bash1 = node(g, 'n:demo:demo-1:009')!;
    expect(bash1.tool).toBe('Bash');
    expect(bash1.status).toBe('error');
    expect(bash1.eventIds).toEqual(['demo:demo-1:009', 'demo:demo-1:010']);
    const bash2 = node(g, 'n:demo:demo-1:013')!;
    expect(bash2.status).toBe('ok');
    const edit1 = node(g, 'n:demo:demo-1:007')!;
    expect(edit1.status).toBe('ok');
    expect(edit1.files).toEqual(['src/pages/login.css']);
  });

  it('三个计划条目各分到步骤，全部 status=ok', () => {
    for (const id of ['plan:0', 'plan:1', 'plan:2']) {
      expect(node(g, id)!.status).toBe('ok');
    }
    // 同快照等分：plan0 → R1,R2,E1；plan1 → V1,E2；plan2 → V2,turn
    expect(node(g, 'n:demo:demo-1:003')!.parentPlanItemId).toBe('plan:0');
    expect(node(g, 'n:demo:demo-1:007')!.parentPlanItemId).toBe('plan:0');
    expect(node(g, 'n:demo:demo-1:009')!.parentPlanItemId).toBe('plan:1');
    expect(node(g, 'n:demo:demo-1:011')!.parentPlanItemId).toBe('plan:1');
    expect(node(g, 'n:demo:demo-1:013')!.parentPlanItemId).toBe('plan:2');
    expect(node(g, 'n:demo:demo-1:015')!.parentPlanItemId).toBe('plan:2');
  });

  it('依赖边：read-edit 两条、verify 两条、contains 三条、seq 若干', () => {
    expect(edgeKinds(g, 'n:demo:demo-1:007')).toContain('read-edit'); // R(login) → E1
    expect(edgeKinds(g, 'n:demo:demo-1:011')).toContain('read-edit'); // R(login) → E2
    expect(edgeKinds(g, 'n:demo:demo-1:009')).toContain('verify'); // E1 → npm test(失败)
    expect(edgeKinds(g, 'n:demo:demo-1:013')).toContain('verify'); // E2 → npm test(通过)
    expect(g.edges.filter((e) => e.kind === 'contains')).toHaveLength(3);
    expect(g.edges.filter((e) => e.kind === 'read-edit')).toHaveLength(2);
    expect(g.edges.filter((e) => e.kind === 'verify')).toHaveLength(2);
    // R2(读 tokens) 没有结构性入边 → seq 兜底到 R1
    expect(edgeKinds(g, 'n:demo:demo-1:005')).toContain('seq');
  });

  it('why 三来源：user / plan / tool-input 依序拼接', () => {
    const edit1 = node(g, 'n:demo:demo-1:007')!;
    expect(edit1.why.map((w) => w.source)).toEqual(['user', 'plan', 'tool-input']);
    expect(edit1.why[0]!.text).toContain('总是错位');
    expect(edit1.why[1]!.text).toBe('定位登录页样式来源');
  });

  it('计划条目 why 带用户需求来源', () => {
    expect(node(g, 'plan:0')!.why).toEqual([{ text: expect.stringContaining('总是错位'), source: 'user' }]);
  });
});

describe('buildGraph — 边界用例', () => {
  it('空输入 → 空图', () => {
    expect(buildGraph([])).toEqual({ sessionId: '', nodes: [], edges: [] });
  });

  it('无计划时：prompt → 第一步 contains，其余靠 read-edit/seq', () => {
    const g = buildGraph([
      ev({ id: 'a', ts: 0, phase: 'user_prompt', title: '用户：看看这个文件' }),
      ev({ id: 'b', ts: 100, phase: 'tool_start', tool: 'Read', title: '读取 a.ts', files: ['a.ts'] }),
      ev({ id: 'c', ts: 200, phase: 'tool_end', tool: 'Read', title: '读取 a.ts', files: ['a.ts'], status: 'ok' }),
      ev({ id: 'd', ts: 300, phase: 'tool_start', tool: 'Edit', title: '修改 a.ts', files: ['a.ts'] }),
      ev({ id: 'e', ts: 400, phase: 'tool_end', tool: 'Edit', title: '修改 a.ts', files: ['a.ts'], status: 'ok' }),
    ]);
    expect(edgeKinds(g, 'n:b')).toContain('contains');
    expect(edgeKinds(g, 'n:d')).toContain('read-edit');
    expect(g.nodes.map((n) => n.kind).sort()).toEqual(['prompt', 'tool', 'tool']);
  });

  it('乱序输入与顺序输入产出完全一致的图（幂等）', () => {
    const shuffled = [...demoSession].reverse();
    expect(buildGraph(shuffled)).toEqual(buildGraph([...demoSession]));
  });

  it('重复 id 只算一次', () => {
    const withDup = [...demoSession, demoSession[2]!];
    expect(buildGraph(withDup).nodes).toHaveLength(11);
  });

  it('孤立 tool_start → status=running', () => {
    const g = buildGraph([
      ev({ id: 'a', ts: 0, phase: 'tool_start', tool: 'Bash', title: '跑构建' }),
    ]);
    expect(g.nodes[0]!.status).toBe('running');
    expect(g.nodes[0]!.eventIds).toEqual(['a']);
  });

  it('分批计划快照：按时间区间归属，条目按文本去重', () => {
    const g = buildGraph([
      ev({ id: 'a', ts: 0, phase: 'user_prompt', title: '用户：干活' }),
      ev({ id: 'b', ts: 1000, phase: 'plan', title: '计划1', planItems: ['先调研'] }),
      ev({ id: 'c', ts: 1500, phase: 'tool_start', tool: 'Read', title: '读 x', files: ['x.ts'] }),
      ev({ id: 'd', ts: 1600, phase: 'tool_end', tool: 'Read', title: '读 x', files: ['x.ts'], status: 'ok' }),
      ev({ id: 'e', ts: 2000, phase: 'plan', title: '计划2', planItems: ['先调研', '再动手'] }),
      ev({ id: 'f', ts: 3000, phase: 'tool_start', tool: 'Edit', title: '改 x', files: ['x.ts'] }),
      ev({ id: 'g', ts: 3100, phase: 'tool_end', tool: 'Edit', title: '改 x', files: ['x.ts'], status: 'ok' }),
    ]);
    expect(g.nodes.filter((n) => n.kind === 'plan-item').map((n) => n.label)).toEqual(['先调研', '再动手']);
    expect(node(g, 'n:c')!.parentPlanItemId).toBe('plan:0');
    expect(node(g, 'n:f')!.parentPlanItemId).toBe('plan:1');
  });

  it('计划条目全是 pending（后续没有步骤）时保持 pending', () => {
    const g = buildGraph([
      ev({ id: 'a', ts: 0, phase: 'user_prompt', title: '用户：规划下' }),
      ev({ id: 'b', ts: 100, phase: 'plan', title: '计划', planItems: ['步骤一', '步骤二'] }),
    ]);
    expect(node(g, 'plan:0')!.status).toBe('pending');
    expect(node(g, 'plan:1')!.status).toBe('pending');
  });

  it('skill 上报的 note 事件生成说明节点，why 优先采用 agent 原话', () => {
    const g = buildGraph([
      ev({ id: 'a', ts: 0, phase: 'user_prompt', title: '用户：修按钮', input: { prompt: '修按钮' } }),
      ev({
        id: 'b',
        ts: 100,
        phase: 'note',
        title: '先读样式，定位按钮错位原因',
        input: { why: '用户说按钮总是错位，先找到样式定义才能改' },
      }),
      ev({ id: 'c', ts: 200, phase: 'tool_start', tool: 'Read', title: '读取 login.css', files: ['login.css'], input: { file_path: 'login.css' } }),
      ev({ id: 'd', ts: 300, phase: 'tool_end', tool: 'Read', title: '读取 login.css', files: ['login.css'], status: 'ok' }),
    ]);
    const note = g.nodes.find((n) => n.kind === 'note')!;
    expect(note.label).toBe('先读样式，定位按钮错位原因');
    // note 的 why：用户需求 + agent 原话（tool-input 来源）
    expect(note.why.map((w) => w.source)).toEqual(['user', 'tool-input']);
    expect(note.why[1]!.text).toContain('先找到样式定义');
    // note 在叙事链上：prompt → note（contains），note → Read（seq 兜底）
    expect(edgeKinds(g, 'n:b')).toContain('contains');
    expect(edgeKinds(g, 'n:c')).toContain('seq');
  });
});
