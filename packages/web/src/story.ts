/**
 * 故事线视图的数据构造：把 Graph 铺成按时间顺序的叙事块，
 * 并用模板生成一段大白话的「任务是怎么完成的」总结（不编造，只重组图里的事实）。
 */
import type { Graph, StepNode } from '@agent-flow/protocol';

export interface StoryBlock {
  step: StepNode;
  /** 失败之后紧跟的操作/说明 → 标记为「补救」 */
  remediation: boolean;
}

export interface Story {
  summary: string;
  blocks: StoryBlock[];
}

export function buildStory(graph: Graph): Story {
  const tools = graph.nodes.filter((n) => n.kind === 'tool');
  const notes = graph.nodes.filter((n) => n.kind === 'note');
  const plans = graph.nodes.filter((n) => n.kind === 'plan-item');
  const turns = graph.nodes.filter((n) => n.kind === 'turn-end');
  const errors = tools.filter((n) => n.status === 'error');

  const count = (tool: string) => tools.filter((t) => t.tool === tool).length;
  const reads = count('Read');
  const edits = tools.filter((t) => ['Edit', 'Write', 'ApplyPatch'].includes(t.tool ?? '')).length;
  const cmds = tools.filter((t) => ['Bash', 'PowerShell', 'Shell'].includes(t.tool ?? '')).length;

  let summary: string;
  if (plans.length > 0) {
    summary = `这个任务分 ${plans.length} 步完成：${plans.map((p) => p.label).join(' → ')}。`;
  } else if (tools.length > 0) {
    summary = '这个任务没有显式计划，AI 直接按顺序执行。';
  } else {
    summary = '本会话暂无执行步骤。';
  }
  const opBits: string[] = [];
  if (reads) opBits.push(`读文件 ${reads} 次`);
  if (edits) opBits.push(`改代码 ${edits} 次`);
  if (cmds) opBits.push(`跑命令 ${cmds} 次`);
  if (opBits.length > 0) summary += `共 ${tools.length} 个操作（${opBits.join('，')}）`;
  if (notes.length > 0) summary += `，穿插了 ${notes.length} 条 AI 的阶段性说明`;
  if (errors.length > 0) summary += `。中途出现 ${errors.length} 次失败，被后续步骤补救`;
  if (opBits.length > 0 || notes.length > 0 || errors.length > 0) summary += '。';
  const conclusion = turns.at(-1);
  if (conclusion) summary += `最终结论：${conclusion.label}`;

  const ordered = [...graph.nodes].sort((a, b) => a.ts - b.ts);
  const blocks: StoryBlock[] = [];
  let afterError = false;
  for (const step of ordered) {
    const isAction = step.kind === 'tool' || step.kind === 'note';
    blocks.push({ step, remediation: afterError && isAction });
    if (step.kind === 'tool') afterError = step.status === 'error';
  }
  return { summary, blocks };
}
