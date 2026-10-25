import type { AgentEvent, Graph, GraphEdge, StepNode, WhySource } from '@agent-flow/protocol';

/**
 * 推理引擎（纯函数）：AgentEvent 事件流 → 可视化图。
 * 规则见 docs/plan.md「冻结接口」与 docs/spec.md：
 * - tool_start/tool_end 配对成工具节点；计划条目成 plan-item 节点并归属步骤；
 * - 依赖边优先级：contains > read-edit（同文件读→改）> verify（修改→测试）> seq（顺序兜底）；
 * - why 从 用户需求 + 计划条目 + 工具入参 拼接，如实标注来源。
 */

const normPath = (p: string) => p.toLowerCase().replace(/\\/g, '/');

const trunc = (s: string, n: number) => (s.length > n ? s.slice(0, n) + '…' : s);

function promptTextOf(ev: AgentEvent | undefined): string | undefined {
  if (!ev) return undefined;
  const inp = ev.input as { prompt?: unknown } | undefined;
  const text = typeof inp?.prompt === 'string' ? inp.prompt : ev.title;
  return trunc(text, 80);
}

function inputSummary(ev: AgentEvent): string | undefined {
  const inp = ev.input as { command?: unknown; why?: unknown } | undefined;
  // agent（skill 上报）自带的 why 是最优解释，优先展示
  if (typeof inp?.why === 'string' && inp.why) return trunc(inp.why, 120);
  if (typeof inp?.command === 'string') return trunc(inp.command, 100);
  if (ev.input === undefined) return undefined;
  try {
    const s = JSON.stringify(ev.input);
    return s === undefined ? undefined : trunc(s, 100);
  } catch {
    return undefined;
  }
}

const VERIFY_TOOLS = new Set(['Bash', 'PowerShell', 'Powershell', 'Shell']);
const VERIFY_RE = /test|spec|vitest|jest|pytest|build|lint|tsc|compile/i;
const EDIT_TOOLS = new Set(['Edit', 'Write', 'ApplyPatch']);
const READ_TOOLS = new Set(['Read']);

interface ToolRec {
  start?: AgentEvent;
  end?: AgentEvent;
}

const sameFiles = (a?: string[], b?: string[]) => {
  if (!a?.length || !b?.length) return true; // 任一方没有 files 信息时不作限制
  const na = new Set(a.map(normPath));
  return b.some((f) => na.has(normPath(f)));
};

function pairTools(events: AgentEvent[]): ToolRec[] {
  const recs: ToolRec[] = [];
  for (const ev of events) {
    if (ev.phase !== 'tool_start' && ev.phase !== 'tool_end') continue;
    if (ev.phase === 'tool_start') {
      recs.push({ start: ev });
      continue;
    }
    // tool_end：回溯找最近的、同工具、未配对、files 相容的 start
    for (let i = recs.length - 1; i >= 0; i--) {
      const r = recs[i]!;
      if (!r.start || r.end) continue;
      if (r.start.tool !== ev.tool) continue;
      if (!sameFiles(r.start.files, ev.files)) continue;
      r.end = ev;
      break;
    }
    if (!recs.some((r) => r.end === ev)) recs.push({ end: ev }); // 孤立 end
  }
  return recs;
}

function isVerify(node: StepNode, ev: AgentEvent): boolean {
  if (!node.tool || !VERIFY_TOOLS.has(node.tool)) return false;
  return VERIFY_RE.test(node.label) || VERIFY_RE.test(JSON.stringify(ev.input ?? {}));
}

export function buildGraph(input: AgentEvent[]): Graph {
  // 去重（保留首个）+ 稳定排序
  const seen = new Set<string>();
  const events = input
    .filter((e) => (seen.has(e.id) ? false : (seen.add(e.id), true)))
    .sort((a, b) => a.ts - b.ts || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const sessionId = events[0]?.sessionId ?? '';
  const nodes: StepNode[] = [];
  const edges: GraphEdge[] = [];

  // ---- prompt 节点 ----
  const promptEv = events.find((e) => e.phase === 'user_prompt');
  const promptText = promptTextOf(promptEv);
  if (promptEv) {
    nodes.push({
      id: 'prompt',
      label: trunc(promptEv.title, 40),
      kind: 'prompt',
      status: 'ok',
      why: [],
      eventIds: [promptEv.id],
      ts: promptEv.ts,
    });
  }

  // ---- plan-item 节点（按文本去重，保留首次出现）----
  interface PlanItem {
    node: StepNode;
    startTs: number;
  }
  const planItems: PlanItem[] = [];
  const planLabels = new Set<string>();
  let planSeq = 0;
  for (const ev of events) {
    if (ev.phase !== 'plan') continue;
    for (const item of ev.planItems ?? []) {
      if (planLabels.has(item)) continue;
      planLabels.add(item);
      const node: StepNode = {
        id: `plan:${planSeq++}`,
        label: item,
        kind: 'plan-item',
        status: 'pending',
        why: promptText ? [{ text: promptText, source: 'user' } satisfies WhySource] : [],
        eventIds: [ev.id],
        ts: ev.ts,
      };
      planItems.push({ node, startTs: ev.ts });
    }
  }
  nodes.push(...planItems.map((p) => p.node));

  // ---- 工具节点 + turn-end 节点 ----
  const toolRecs = pairTools(events);
  const toolNodes: StepNode[] = toolRecs.map((r) => {
    const head = r.start ?? r.end!;
    return {
      id: `n:${head.id}`,
      label: head.title,
      kind: 'tool' as const,
      status: r.end ? (r.end.status ?? 'ok') : ('running' as const),
      tool: head.tool,
      files: head.files,
      why: [],
      eventIds: [r.start?.id, r.end?.id].filter((x): x is string => !!x),
      ts: head.ts,
    };
  });
  const turnNodes: StepNode[] = events
    .filter((e) => e.phase === 'turn_end')
    .map((e) => ({
      id: `n:${e.id}`,
      label: e.title,
      kind: 'turn-end' as const,
      status: 'ok' as const,
      why: [],
      eventIds: [e.id],
      ts: e.ts,
    }));
  // note 事件：skill 上报的 agent 原话说明（最有人味的节点）
  const noteNodes: StepNode[] = events
    .filter((e) => e.phase === 'note' && e.title)
    .map((e) => ({
      id: `n:${e.id}`,
      label: e.title,
      kind: 'note' as const,
      status: 'ok' as const,
      why: [],
      eventIds: [e.id],
      ts: e.ts,
    }));
  nodes.push(...toolNodes, ...turnNodes, ...noteNodes);

  const steps = [...toolNodes, ...turnNodes, ...noteNodes].sort(
    (a, b) => a.ts - b.ts || (a.id < b.id ? -1 : 1),
  );

  // ---- 步骤 → 计划条目归属 ----
  // 同一快照（startTs 全相同）的条目按顺序等分后续步骤；
  // 分批快照（startTs 不同）用时间区间 [start_i, start_{i+1})。
  if (planItems.length > 0) {
    const firstTs = planItems[0]!.startTs;
    const staggered = planItems.some((p) => p.startTs !== firstTs);
    if (staggered) {
      for (const s of steps) {
        let owner: PlanItem | undefined;
        for (const p of planItems) {
          if (p.startTs <= s.ts) owner = p;
          else break;
        }
        s.parentPlanItemId = owner?.node.id;
      }
    } else {
      const later = steps.filter((s) => s.ts >= firstTs);
      const k = planItems.length;
      later.forEach((s, idx) => {
        const which = Math.min(k - 1, Math.floor((idx * k) / later.length));
        s.parentPlanItemId = planItems[which]!.node.id;
      });
    }
    // 计划条目状态：没分到步骤 = pending；名下还有进行中的步骤 = running；
    // 其余 = ok（历史上失败过但已收尾的仍算完成，失败体现在步骤节点本身）
    for (const p of planItems) {
      const owned = steps.filter((s) => s.parentPlanItemId === p.node.id);
      p.node.status =
        owned.length === 0 ? 'pending' : owned.some((s) => s.status === 'running') ? 'running' : 'ok';
    }
  }

  // ---- why ----
  const planById = new Map(planItems.map((p) => [p.node.id, p.node]));
  for (const s of [...toolNodes, ...noteNodes]) {
    const head = events.find((e) => e.id === s.eventIds[0]) ?? events.find((e) => s.eventIds.includes(e.id));
    if (promptText) s.why.push({ text: promptText, source: 'user' });
    const parent = s.parentPlanItemId ? planById.get(s.parentPlanItemId) : undefined;
    if (parent) s.why.push({ text: parent.label, source: 'plan' });
    if (head) {
      const summary = inputSummary(head);
      if (summary) s.why.push({ text: summary, source: 'tool-input' });
    }
  }

  // ---- 边 ----
  // 1. contains：prompt → 每个计划条目；无计划时 prompt → 第一个步骤
  if (promptEv) {
    if (planItems.length > 0) {
      for (const p of planItems) edges.push({ from: 'prompt', to: p.node.id, kind: 'contains' });
    } else if (steps.length > 0) {
      edges.push({ from: 'prompt', to: steps[0]!.id, kind: 'contains' });
    }
  }

  const byId = new Map(nodes.map((n) => [n.id, n]));
  const toolByTs = [...toolNodes].sort((a, b) => a.ts - b.ts);

  // 2. read-edit：Edit/Write 与共享文件的最近一次 Read。
  //    用排序位置而非 ts 比较：同毫秒批量到达（hook 一次 POST 多条）也能连边
  for (let i = 0; i < toolByTs.length; i++) {
    const e = toolByTs[i]!;
    if (!e.tool || !EDIT_TOOLS.has(e.tool)) continue;
    const eFiles = new Set((e.files ?? []).map(normPath));
    if (eFiles.size === 0) continue;
    let best: StepNode | undefined;
    for (let j = i - 1; j >= 0; j--) {
      const r = toolByTs[j]!;
      if (r.tool && READ_TOOLS.has(r.tool) && (r.files ?? []).some((f) => eFiles.has(normPath(f)))) {
        best = r;
        break;
      }
    }
    if (best) edges.push({ from: best.id, to: e.id, kind: 'read-edit' });
  }

  // 3. verify：验证类节点 收 上个验证节点之后的全部 Edit/Write（同样按位置界定区间）
  const verifyIdx: number[] = [];
  toolByTs.forEach((n, i) => {
    const head = events.find((e) => e.id === n.eventIds[0]);
    if (head && isVerify(n, head)) verifyIdx.push(i);
  });
  let prevVerify = -1;
  for (const vi of verifyIdx) {
    for (let ei = prevVerify + 1; ei < vi; ei++) {
      const e = toolByTs[ei]!;
      if (e.tool && EDIT_TOOLS.has(e.tool)) edges.push({ from: e.id, to: toolByTs[vi]!.id, kind: 'verify' });
    }
    prevVerify = vi;
  }

  // 4. seq 兜底：无入边的工具/说明节点连到前一个（同计划组优先）
  const seqChain = [...toolNodes, ...noteNodes].sort((a, b) => a.ts - b.ts);
  const hasIncoming = (id: string) => edges.some((ed) => ed.to === id);
  for (const t of seqChain) {
    if (hasIncoming(t.id)) continue;
    const before = seqChain.filter((r) => r.ts < t.ts);
    const p =
      before.filter((r) => r.parentPlanItemId && r.parentPlanItemId === t.parentPlanItemId).at(-1) ??
      before.at(-1);
    if (p) edges.push({ from: p.id, to: t.id, kind: 'seq' });
  }

  // 计划条目之间不加链边：图上由分组位置表达顺序，连线只留给步骤间的真实依赖
  void byId;
  return { sessionId, nodes, edges };
}
