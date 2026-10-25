import { demoSession, agentEventSchema, type AgentEvent } from '@agent-flow/protocol';

export interface DemoScenario {
  name: string;
  description: string;
  /** ts 为相对偏移（演示器按间隔换算成真实时间），id 已映射到给定 sessionId */
  events(sessionId: string): AgentEvent[];
}

/** 经典场景：修按钮错位（读→改→测试失败→补救→通过） */
export const classicScenario: DemoScenario = {
  name: 'classic',
  description: '修按钮错位：读文件→改样式→测试失败→补救→通过',
  events(sessionId) {
    return demoSession.map((ev) => ({ ...ev, sessionId, id: ev.id.replace('demo-1', sessionId) }));
  },
};

type RawEvent = Omit<AgentEvent, 'id' | 'ts' | 'sessionId'> & { ts: number };

/** skill 场景：模拟已装 agent-flow skill 的 ZCode 会话（AI 原话 why + note 说明） */
const skillStory: RawEvent[] = [
  { adapter: 'zcode', phase: 'user_prompt', ts: 0, title: '用户：构建从 40 秒涨到了 2 分钟，帮我查一下为什么', input: { prompt: '构建从 40 秒涨到了 2 分钟，帮我查一下为什么' } },
  { adapter: 'zcode', phase: 'plan', ts: 2000, title: '制定计划（3 步）', planItems: ['对比最近改动缩小范围', '定位耗时环节', '修复并验证'] },
  { adapter: 'zcode', phase: 'note', ts: 4000, title: '先看最近一周的提交记录', input: { why: '用户说构建突然变慢，最大概率是最近的改动引入的，先缩小范围最省时间' } },
  { adapter: 'zcode', phase: 'tool_start', ts: 5500, tool: 'Bash', title: 'git log 查看最近提交', input: { command: 'git log --since=1.week --oneline', why: '找最近改过构建相关文件的提交' } },
  { adapter: 'zcode', phase: 'tool_end', ts: 8000, tool: 'Bash', title: 'git log 查看最近提交', status: 'ok', output: { summary: '3 个提交，其中 1 个改了 build.ts' } },
  { adapter: 'zcode', phase: 'note', ts: 10000, title: 'build.ts 里新加了一个同步的大文件拷贝，最可疑', input: { why: '改动里只有 build.ts 动了构建流程，copySync 每次全量拷贝 200MB 资源，直接解释了变慢' } },
  { adapter: 'zcode', phase: 'tool_start', ts: 12000, tool: 'Read', files: ['build.ts'], title: '读取 build.ts 的拷贝段落', input: { path: 'build.ts', why: '确认拷贝逻辑，决定怎么改' } },
  { adapter: 'zcode', phase: 'tool_end', ts: 14000, tool: 'Read', files: ['build.ts'], title: '读取 build.ts 的拷贝段落', status: 'ok' },
  { adapter: 'zcode', phase: 'tool_start', ts: 16000, tool: 'Edit', files: ['build.ts'], title: '把全量拷贝改成增量拷贝', input: { why: '全量拷贝是主要嫌疑，先改成只在文件变化时拷贝' } },
  { adapter: 'zcode', phase: 'tool_end', ts: 18500, tool: 'Edit', files: ['build.ts'], title: '把全量拷贝改成增量拷贝', status: 'ok' },
  { adapter: 'zcode', phase: 'tool_start', ts: 21000, tool: 'Bash', title: '跑一次构建验证', input: { command: 'npm run build', why: '改动后必须实测，不能凭感觉' } },
  { adapter: 'zcode', phase: 'tool_end', ts: 26000, tool: 'Bash', title: '跑一次构建验证', status: 'error', output: { summary: '仍然 95s —— 还有别的瓶颈' } },
  { adapter: 'zcode', phase: 'note', ts: 28000, title: '还是慢，说明瓶颈不止一个，继续查缓存配置', input: { why: '增量拷贝只省了少量时间，95 秒说明还有大头，构建缓存配置是下一个最可疑点' } },
  { adapter: 'zcode', phase: 'tool_start', ts: 30000, tool: 'Edit', files: ['build.ts'], title: '开启构建内容缓存', input: { why: '缓存命中可以跳过未变模块的重新编译' } },
  { adapter: 'zcode', phase: 'tool_end', ts: 32500, tool: 'Edit', files: ['build.ts'], title: '开启构建内容缓存', status: 'ok' },
  { adapter: 'zcode', phase: 'tool_start', ts: 35000, tool: 'Bash', title: '再跑一次构建验证', input: { command: 'npm run build' } },
  { adapter: 'zcode', phase: 'tool_end', ts: 40000, tool: 'Bash', title: '再跑一次构建验证', status: 'ok', output: { summary: '12s，达标' } },
  { adapter: 'zcode', phase: 'turn_end', ts: 42000, title: '构建从 2 分钟降回 12 秒：改增量拷贝 + 开启内容缓存，两个瓶颈都修掉了', output: { summary: '两个瓶颈：全量拷贝、无缓存' } },
];

export const skillScenario: DemoScenario = {
  name: 'skill',
  description: '排查构建变慢（skill 会话：AI 原话 why + 失败补救）',
  events(sessionId) {
    return skillStory.map((ev, i) => ({ ...ev, sessionId, id: `${sessionId}-${i + 1}` }));
  },
};

export const scenarios: DemoScenario[] = [skillScenario, classicScenario];

/** 校验场景里每条事件都是合法 AgentEvent（供测试与自检） */
export function validateScenario(scenario: DemoScenario): string[] {
  const problems: string[] = [];
  const events = scenario.events('check-session');
  const ids = new Set<string>();
  events.forEach((ev, i) => {
    if (!agentEventSchema.safeParse(ev).success) problems.push(`第 ${i + 1} 条事件不合法`);
    if (ids.has(ev.id)) problems.push(`id 重复：${ev.id}`);
    ids.add(ev.id);
  });
  return problems;
}
