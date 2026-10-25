/**
 * Graph → React Flow 的节点/边转换 + elkjs 自动布局。
 *
 * 分组的务实做法：plan-item 作为 elk 的 compound 节点（含子节点）一起参与
 * layered 分层布局（hierarchyHandling: INCLUDE_CHILDREN，跨层边也能布好），
 * 布局完成后用 React Flow 的 parentId + extent:'parent' 做视觉容器——
 * elk 的 padding 顶部预留出分组标题条的高度，子节点坐标天然是分组内相对坐标。
 */
import type { Edge, Node } from '@xyflow/react';
import { MarkerType } from '@xyflow/react';
import type { EdgeKind, Graph, StepNode } from '@agent-flow/protocol';
import ELK from 'elkjs/lib/elk.bundled.js';
import type { ElkNode } from 'elkjs/lib/elk-api';

export type FlowNodeData = { step: StepNode; fresh: boolean };
export type FlowNode = Node<FlowNodeData>;

export interface LayoutResult {
  nodes: FlowNode[];
  edges: Edge[];
}

/** 分组节点：标题条高度 + 内边距（与 styles.css 的 .af-plan-header 保持一致） */
const GROUP_HEADER = 34;
const GROUP_PADDING = 14;

const elk = new ELK();

export function nodeTypeOf(step: StepNode): string {
  switch (step.kind) {
    case 'prompt':
      return 'af-prompt';
    case 'plan-item':
      return 'af-plan';
    case 'turn-end':
      return 'af-turnend';
    default:
      return 'af-tool';
  }
}

/** 粗略文字宽度估算（px @14px 字号），用于给 elk 提供节点尺寸 */
function estimateTextWidth(text: string): number {
  let w = 0;
  for (const ch of text) w += ch.codePointAt(0)! > 0x2e7f ? 14.5 : 8.2;
  return w;
}

function measure(step: StepNode): { width: number; height: number } {
  switch (step.kind) {
    case 'prompt':
      return { width: 360, height: 68 };
    case 'turn-end':
      return { width: 280, height: 54 };
    case 'plan-item':
      // 空分组的最小尺寸；有子节点时 elk 会按内容撑开
      return { width: 260, height: GROUP_HEADER + 2 * GROUP_PADDING + 40 };
    default: {
      const label = estimateTextWidth(step.label);
      const tool = estimateTextWidth(step.tool ?? '');
      const width = Math.min(380, Math.max(230, Math.ceil(Math.max(label + 42, tool + 62))));
      return { width, height: 64 };
    }
  }
}

/** 同一对端点出现多条不同 kind 的边时，保留语义最强的一条 */
const EDGE_PRIORITY: Record<EdgeKind, number> = { verify: 4, 'read-edit': 3, contains: 2, seq: 1 };

function toFlowEdge(from: string, to: string, kind: EdgeKind): Edge {
  const base = { id: `e-${from}-${to}`, source: from, target: to };
  switch (kind) {
    case 'read-edit':
      return {
        ...base,
        label: '读→改',
        style: { stroke: '#b3b3bd', strokeWidth: 2.4 },
        labelStyle: { fill: '#b3b3bd', fontSize: 11, fontWeight: 600 },
        labelBgStyle: { fill: '#0a0a0a', fillOpacity: 0.92 },
        labelBgPadding: [5, 3],
        labelBgBorderRadius: 3,
        markerEnd: { type: MarkerType.ArrowClosed, width: 15, height: 15, color: '#b3b3bd' },
      };
    case 'verify':
      return {
        ...base,
        label: '验证',
        style: { stroke: '#8f8f9a', strokeWidth: 2.4, strokeDasharray: '8 5' },
        labelStyle: { fill: '#8f8f9a', fontSize: 11, fontWeight: 600 },
        labelBgStyle: { fill: '#0a0a0a', fillOpacity: 0.92 },
        labelBgPadding: [5, 3],
        labelBgBorderRadius: 3,
        markerEnd: { type: MarkerType.ArrowClosed, width: 15, height: 15, color: '#8f8f9a' },
      };
    case 'seq':
      return {
        ...base,
        style: { stroke: '#4a4a52', strokeWidth: 1.6, strokeDasharray: '3 6' },
        markerEnd: { type: MarkerType.ArrowClosed, width: 11, height: 11, color: '#4a4a52' },
      };
    default: // contains
      return {
        ...base,
        style: { stroke: '#2e2e33', strokeWidth: 1.3, strokeDasharray: '6 5' },
      };
  }
}

/** elk 布局失败时的兜底：网格摆放，保证图仍然可见 */
function fallbackLayout(graph: Graph, prevIds: ReadonlySet<string>): LayoutResult {
  const nodes: FlowNode[] = graph.nodes.map((step, i) => {
    const m = measure(step);
    return {
      id: step.id,
      type: nodeTypeOf(step),
      position: { x: (i % 5) * 320, y: Math.floor(i / 5) * 120 },
      data: { step, fresh: !prevIds.has(step.id) },
      width: m.width,
      height: m.height,
      style: { width: m.width, height: m.height },
    };
  });
  const seen = new Map<string, EdgeKind>();
  const edges: Edge[] = [];
  for (const e of graph.edges) {
    if (seen.has(`${e.from}->${e.to}`)) continue;
    seen.set(`${e.from}->${e.to}`, e.kind);
    edges.push(toFlowEdge(e.from, e.to, e.kind));
  }
  return { nodes, edges };
}

export async function computeLayout(graph: Graph, prevIds: ReadonlySet<string>): Promise<LayoutResult> {
  const nodesById = new Map(graph.nodes.map((n) => [n.id, n]));
  const childrenOf = new Map<string, StepNode[]>();
  for (const n of graph.nodes) {
    // plan-item 自身不作为子节点（分组不嵌套）；孤儿引用按顶层处理
    if (n.kind !== 'plan-item' && n.parentPlanItemId && nodesById.has(n.parentPlanItemId)) {
      const arr = childrenOf.get(n.parentPlanItemId) ?? [];
      arr.push(n);
      childrenOf.set(n.parentPlanItemId, arr);
    }
  }

  const groupPadding = `[top=${GROUP_HEADER + GROUP_PADDING},left=${GROUP_PADDING},bottom=${GROUP_PADDING},right=${GROUP_PADDING}]`;

  const elkChildren: ElkNode[] = [];
  // 分组容器节点在前（React Flow 同层按数组顺序渲染，父先子后保证子节点盖在分组上）
  for (const step of graph.nodes) {
    if (step.kind !== 'plan-item') continue;
    const min = measure(step);
    const children = (childrenOf.get(step.id) ?? []).map((c) => {
      const m = measure(c);
      return { id: c.id, width: m.width, height: m.height };
    });
    elkChildren.push({
      id: step.id,
      width: min.width,
      height: min.height,
      layoutOptions: { 'elk.padding': groupPadding },
      children,
    });
  }
  for (const step of graph.nodes) {
    if (step.kind === 'plan-item') continue;
    if (childrenOf.has(step.id)) continue; // 已作为分组子节点
    const m = measure(step);
    elkChildren.push({ id: step.id, width: m.width, height: m.height });
  }

  const edgeMap = new Map<string, { from: string; to: string; kind: EdgeKind }>();
  for (const e of graph.edges) {
    if (e.from === e.to) continue;
    if (!nodesById.has(e.from) || !nodesById.has(e.to)) continue;
    const key = `${e.from}->${e.to}`;
    const prev = edgeMap.get(key);
    if (!prev || EDGE_PRIORITY[e.kind] > EDGE_PRIORITY[prev.kind]) {
      edgeMap.set(key, { from: e.from, to: e.to, kind: e.kind });
    }
  }

  const root: ElkNode = {
    id: 'root',
    layoutOptions: {
      'elk.algorithm': 'layered',
      'elk.direction': 'DOWN',
      'elk.hierarchyHandling': 'INCLUDE_CHILDREN',
      'elk.layerSpacing': '72',
      'elk.nodeSpacing': '30',
      'elk.spacing.edgeNode': '30',
      'elk.padding': '[top=24,left=24,bottom=24,right=24]',
    },
    children: elkChildren,
    edges: [...edgeMap.values()].map((e) => ({
      id: `e-${e.from}-${e.to}`,
      sources: [e.from],
      targets: [e.to],
    })),
  };

  let out: ElkNode;
  try {
    out = await elk.layout(root);
  } catch {
    return fallbackLayout(graph, prevIds);
  }
  if (!out.children || out.children.length === 0) {
    return fallbackLayout(graph, prevIds);
  }

  const makeNode = (
    step: StepNode,
    x: number,
    y: number,
    w: number,
    h: number,
    parentId?: string,
  ): FlowNode => ({
    id: step.id,
    type: nodeTypeOf(step),
    position: { x, y },
    data: { step, fresh: !prevIds.has(step.id) },
    ...(parentId ? { parentId, extent: 'parent' as const } : {}),
    ...(step.kind === 'plan-item' ? { dragHandle: '.af-plan-header' } : {}),
    width: w,
    height: h,
    style: { width: w, height: h },
  });

  const groups: FlowNode[] = [];
  const leaves: FlowNode[] = [];
  for (const top of out.children) {
    const step = nodesById.get(top.id);
    if (!step) continue;
    if (step.kind === 'plan-item') {
      groups.push(makeNode(step, top.x ?? 0, top.y ?? 0, top.width ?? 220, top.height ?? 100));
      for (const child of top.children ?? []) {
        const childStep = nodesById.get(child.id);
        if (childStep) {
          leaves.push(
            makeNode(childStep, child.x ?? 0, child.y ?? 0, child.width ?? 190, child.height ?? 52, step.id),
          );
        }
      }
    } else {
      leaves.push(makeNode(step, top.x ?? 0, top.y ?? 0, top.width ?? 190, top.height ?? 52));
    }
  }

  return { nodes: [...groups, ...leaves], edges: [...edgeMap.values()].map((e) => toFlowEdge(e.from, e.to, e.kind)) };
}
