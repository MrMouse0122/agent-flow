import type { AgentEvent } from './types.js';

/**
 * 演示会话：一个贴近真实的「修 bug → 测试失败 → 修复 → 测试通过」流程。
 * 被 demo 模拟器、inference 测试和 web 开发共用。
 * ts 用相对偏移（demo 模拟器会换算成真实时间）。
 */
export const DEMO_SESSION_ID = 'demo-1';

let seq = 0;
const e = (event: Omit<AgentEvent, 'id' | 'sessionId' | 'adapter'>): AgentEvent => {
  seq += 1;
  return { ...event, id: `demo:${DEMO_SESSION_ID}:${String(seq).padStart(3, '0')}`, sessionId: DEMO_SESSION_ID, adapter: 'demo' };
};

export const demoSession: AgentEvent[] = [
  e({
    ts: 0,
    phase: 'user_prompt',
    title: '用户：移动端登录页的提交按钮总是错位，帮我修好并跑下测试',
    input: { prompt: '移动端登录页的提交按钮总是错位，帮我修好并跑下测试' },
  }),
  e({
    ts: 2000,
    phase: 'plan',
    title: '制定计划（3 步）',
    planItems: ['定位登录页样式来源', '修改响应式样式', '运行测试验证'],
  }),
  e({
    ts: 3000,
    phase: 'tool_start',
    tool: 'Read',
    title: '读取 src/pages/login.css',
    files: ['src/pages/login.css'],
    input: { path: 'src/pages/login.css' },
  }),
  e({
    ts: 3300,
    phase: 'tool_end',
    tool: 'Read',
    title: '读取 src/pages/login.css',
    files: ['src/pages/login.css'],
    status: 'ok',
    output: { lines: 210, preview: '@media (max-width: 480px) { .submit-btn { … } }' },
  }),
  e({
    ts: 4000,
    phase: 'tool_start',
    tool: 'Read',
    title: '读取 src/styles/tokens.css',
    files: ['src/styles/tokens.css'],
    input: { path: 'src/styles/tokens.css' },
  }),
  e({
    ts: 4400,
    phase: 'tool_end',
    tool: 'Read',
    title: '读取 src/styles/tokens.css',
    files: ['src/styles/tokens.css'],
    status: 'ok',
    output: { lines: 88, preview: '--btn-width-sm: 100%;' },
  }),
  e({
    ts: 6000,
    phase: 'tool_start',
    tool: 'Edit',
    title: '修改 src/pages/login.css：按钮媒体查询宽度',
    files: ['src/pages/login.css'],
    input: { old: 'width: 88px', new: 'width: 100%' },
  }),
  e({
    ts: 6500,
    phase: 'tool_end',
    tool: 'Edit',
    title: '修改 src/pages/login.css：按钮媒体查询宽度',
    files: ['src/pages/login.css'],
    status: 'ok',
    output: { applied: true },
  }),
  e({
    ts: 8000,
    phase: 'tool_start',
    tool: 'Bash',
    title: '运行 npm test',
    input: { command: 'npm test' },
  }),
  e({
    ts: 11000,
    phase: 'tool_end',
    tool: 'Bash',
    title: '运行 npm test',
    status: 'error',
    output: { exitCode: 1, summary: '2 failing — login.spec.ts: 按钮宽度断言失败' },
  }),
  e({
    ts: 13000,
    phase: 'tool_start',
    tool: 'Edit',
    title: '修复 login.spec.ts 对应的按钮宽度断言',
    files: ['src/pages/login.css'],
    input: { old: 'width: 88px', new: 'width: 100%' },
  }),
  e({
    ts: 13500,
    phase: 'tool_end',
    tool: 'Edit',
    title: '修复 login.spec.ts 对应的按钮宽度断言',
    files: ['src/pages/login.css'],
    status: 'ok',
    output: { applied: true },
  }),
  e({
    ts: 15000,
    phase: 'tool_start',
    tool: 'Bash',
    title: '再次运行 npm test',
    input: { command: 'npm test' },
  }),
  e({
    ts: 18000,
    phase: 'tool_end',
    tool: 'Bash',
    title: '再次运行 npm test',
    status: 'ok',
    output: { exitCode: 0, summary: '36 passed' },
  }),
  e({
    ts: 19000,
    phase: 'turn_end',
    title: '完成：按钮错位已修复，测试全绿',
    output: { summary: '修改 login.css 的媒体查询宽度为 100%，测试 36 通过' },
  }),
];

/** 供 web 本地开发 / 回放测试用的第二个短会话 */
export const demoSession2: AgentEvent[] = [
  e({ ts: 0, phase: 'user_prompt', title: '用户：这个函数是干嘛的？', input: { prompt: '这个函数是干嘛的？' } }),
  e({ ts: 1500, phase: 'tool_start', tool: 'Read', title: '读取 src/utils/schedule.ts', files: ['src/utils/schedule.ts'], input: { path: 'src/utils/schedule.ts' } }),
  e({ ts: 1900, phase: 'tool_end', tool: 'Read', title: '读取 src/utils/schedule.ts', files: ['src/utils/schedule.ts'], status: 'ok', output: { lines: 42 } }),
  e({ ts: 3000, phase: 'turn_end', title: '回答：这是一个定时任务调度器…', output: { summary: '解释了 schedule() 的用途' } }),
].map((ev) => ({ ...ev, sessionId: 'demo-2', id: ev.id.replace(':demo-1:', ':demo-2:') }));
