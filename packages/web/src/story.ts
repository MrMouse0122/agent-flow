/**
 * 故事线视图的数据构造：把 Graph 铺成按时间顺序的叙事块。
 * 面向"小白可读"：每一步除了"做了什么/为什么"，还带
 *  - connect：与上一步的联系（基于读到的内容修改 / 改完立即验证 / 失败后的补救…）
 *  - result：这一步的结果（输出摘要，失败显示错误信息）
 *  - index：步骤序号
 * 顶部总结为模板生成的大白话段落（不编造，只重组图里的事实）。
 */
import type { AgentEvent, Graph, StepNode } from '@agent-flow/protocol';
import type { EdgeKind } from '@agent-flow/protocol';

export interface StoryBlock {
  step: StepNode;
  /** 失败之后紧跟的操作/说明 → 标记为「补救」 */
  remediation: boolean;
  /** 与上一步的联系（承接说明） */
  connect?: string;
  /** 这一步的结果摘要（来自事件 output） */
  result?: string;
  /** 动作序号（工具/说明节点统一编号） */
  index?: number;
}

export interface StoryPlanBlock extends StoryBlock {
  /** 该计划条目下的动作数 */
  actionCount: number;
  planIndex: number;
}

export interface Story {
  summary: string;
  blocks: StoryBlock[];
}

const EDGE_PRIORITY: Record<EdgeKind, number> = { verify: 4, 'read-edit': 3, contains: 2, seq: 1 };

function outputSummary(events: AgentEvent[], block: StoryBlock): string | undefined {
  const related = events.filter((e) => block.step.eventIds.includes(e.id));
  const withOutput = related.filter((e) => e.output !== undefined).at(-1);
  if (!withOutput) return undefined;
  const out = withOutput.output as { summary?: unknown } | undefined;
  if (typeof out?.summary === 'string' && out.summary) return out.summary;
  try {
    const s = JSON.stringify(withOutput.output);
    return s && s.length > 0 ? (s.length > 90 ? s.slice(0, 90) + '…' : s) : undefined;
  } catch {
    return undefined;
  }
}

export function buildStory(graph: Graph, events: AgentEvent[] = []): Story {
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

  // 每个节点最强的入边类型（决定承接话术）
  const incoming = new Map<string, EdgeKind>();
  for (const e of graph.edges) {
    const prev = incoming.get(e.to);
    if (!prev || EDGE_PRIORITY[e.kind] > EDGE_PRIORITY[prev]) incoming.set(e.to, e.kind);
  }

  const ordered = [...graph.nodes].sort((a, b) => a.ts - b.ts);
  const blocks: StoryBlock[] = [];
  let afterError = false;
  let actionIndex = 0;
  for (const step of ordered) {
    if (step.kind === 'plan-item') {
      const actionCount = graph.nodes.filter(
        (n) => n.parentPlanItemId === step.id && n.kind === 'tool',
      ).length;
      const planBlock: StoryPlanBlock = {
        step,
        remediation: false,
        actionCount,
        planIndex: plans.indexOf(step) + 1,
      };
      blocks.push(planBlock);
      continue;
    }
    if (step.kind === 'prompt') {
      blocks.push({ step, remediation: false });
      continue;
    }

    const isAction = step.kind === 'tool' || step.kind === 'note';
    actionIndex += isAction ? 1 : 0;
    const block: StoryBlock = {
      step,
      remediation: afterError && isAction,
      index: isAction ? actionIndex : undefined,
    };

    // 承接话术：与上一步的联系
    const edge = incoming.get(step.id);
    if (block.remediation) {
      block.connect = '上一步失败了，这一步是针对失败的补救';
    } else if (step.kind === 'turn-end') {
      block.connect = '所有步骤结束，收尾总结';
    } else if (edge === 'read-edit') {
      block.connect = '基于刚才读到的文件内容动手修改';
    } else if (edge === 'verify') {
      block.connect = '修改完成，立即验证效果';
    } else if (edge === 'contains') {
      block.connect = '任务起点：直接响应用户的问题';
    } else if (step.kind === 'note') {
      block.connect = afterError ? '失败后的判断：下一步怎么办' : '阶段性判断：说明接下来的思路';
    } else {
      block.connect = '按顺序推进';
    }

    block.result = outputSummary(events, block);
    blocks.push(block);
    if (step.kind === 'tool') afterError = step.status === 'error';
  }
  return { summary, blocks };
}
