/**
 * 中间画布：Graph → React Flow。
 * - elkjs 布局在 layout.ts 中完成，graph 更新防抖 120ms 重算；
 * - 节点卡片带一行「原因」说明；计划分组标题带 第N步/动作数；
 * - 悬停或选中某节点时，聚焦它及其连线（其余节点与边淡出），看清步骤间的联系；
 * - 点击节点开详情，点击画布空白处关闭。
 */
import {
  Background,
  Controls,
  Handle,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useEdgesState,
  useNodesState,
  useReactFlow,
} from '@xyflow/react';
import type { Edge, NodeProps, NodeTypes } from '@xyflow/react';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { Graph, StepNode } from '@agent-flow/protocol';
import { computeLayout, cssVar, type FlowNode } from './layout';

interface CanvasProps {
  graph: Graph | null;
  /** 会话标识变化时重置节点集合并自动 FitView */
  sessionKey: string;
  /** 当前选中的节点（详情面板打开时保持聚焦高亮） */
  selectedNodeId?: string | null;
  onSelectNode: (nodeId: string | null) => void;
}

function statusClass(step: { status: string }): string {
  return `af-st-${step.status}`;
}

/** 卡片上的一行原因（优先 agent 原话，其次计划条目） */
function whyText(step: StepNode): string | undefined {
  const pick = step.why.find((w) => w.source === 'tool-input' && w.text) ?? step.why[0];
  return pick?.text;
}

function PromptNode({ data, selected }: NodeProps<FlowNode>) {
  const { step, fresh } = data;
  return (
    <div className={`af-node af-prompt ${fresh ? 'af-fresh' : ''} ${selected ? 'af-selected' : ''}`}>
      <Handle type="target" position={Position.Top} className="af-handle" />
      <div className="af-prompt-icon" aria-hidden>
        ✦
      </div>
      <div className="af-node-label af-clamp2" title={step.label}>
        {step.label}
      </div>
      <Handle type="source" position={Position.Bottom} className="af-handle" />
    </div>
  );
}

function PlanNode({ data, selected }: NodeProps<FlowNode>) {
  const { step, fresh, planIndex, actionCount } = data;
  return (
    <div className={`af-node af-plan ${fresh ? 'af-fresh' : ''} ${selected ? 'af-selected' : ''}`}>
      <Handle type="target" position={Position.Top} className="af-handle" />
      <div className="af-plan-header">
        <span className="af-badge af-badge-plan">{typeof planIndex === 'number' ? `第 ${planIndex + 1} 步` : '计划'}</span>
        <span className="af-plan-title" title={step.label}>
          {step.label}
        </span>
        {typeof actionCount === 'number' && (
          <span className="af-plan-meta">{actionCount} 个动作</span>
        )}
      </div>
      <Handle type="source" position={Position.Bottom} className="af-handle" />
    </div>
  );
}

function ToolNode({ data, selected }: NodeProps<FlowNode>) {
  const { step, fresh } = data;
  const why = whyText(step);
  return (
    <div
      className={`af-node af-tool ${statusClass(step)} ${fresh ? 'af-fresh' : ''} ${selected ? 'af-selected' : ''}`}
    >
      <Handle type="target" position={Position.Top} className="af-handle" />
      <div className="af-tool-top">
        <span className="af-badge af-badge-tool" title={step.tool}>
          {step.tool ?? '工具'}
        </span>
        <span className="af-status-dot" />
      </div>
      <div className="af-node-label af-ellipsis" title={step.label}>
        {step.label}
      </div>
      {why && (
        <div className="af-node-why af-ellipsis" title={why}>
          ↳ {why}
        </div>
      )}
      <Handle type="source" position={Position.Bottom} className="af-handle" />
    </div>
  );
}

function NoteNode({ data, selected }: NodeProps<FlowNode>) {
  const { step, fresh } = data;
  const why = whyText(step);
  return (
    <div className={`af-node af-note ${fresh ? 'af-fresh' : ''} ${selected ? 'af-selected' : ''}`}>
      <Handle type="target" position={Position.Top} className="af-handle" />
      <div className="af-tool-top">
        <span className="af-badge af-kind-note">AI 说明</span>
      </div>
      <div className="af-node-label af-ellipsis" title={step.label}>
        {step.label}
      </div>
      {why && (
        <div className="af-node-why af-ellipsis" title={why}>
          ↳ {why}
        </div>
      )}
      <Handle type="source" position={Position.Bottom} className="af-handle" />
    </div>
  );
}

function TurnEndNode({ data, selected }: NodeProps<FlowNode>) {
  const { step, fresh } = data;
  return (
    <div className={`af-node af-turnend ${statusClass(step)} ${fresh ? 'af-fresh' : ''} ${selected ? 'af-selected' : ''}`}>
      <Handle type="target" position={Position.Top} className="af-handle" />
      <span className="af-turnend-check" aria-hidden>
        ✓
      </span>
      <span className="af-node-label af-ellipsis" title={step.label}>
        {step.label}
      </span>
      <Handle type="source" position={Position.Bottom} className="af-handle" />
    </div>
  );
}

const nodeTypes: NodeTypes = {
  'af-prompt': PromptNode,
  'af-plan': PlanNode,
  'af-tool': ToolNode,
  'af-note': NoteNode,
  'af-turnend': TurnEndNode,
};

const FIT_OPTIONS = { padding: 0.12, maxZoom: 1.15, duration: 400 };

function CanvasInner({ graph, sessionKey, selectedNodeId, onSelectNode }: CanvasProps) {
  const [nodes, setNodes, onNodesChange] = useNodesState<FlowNode>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const [hoverId, setHoverId] = useState<string | null>(null);
  const prevIdsRef = useRef<ReadonlySet<string>>(new Set());
  const layoutSeqRef = useRef(0);
  const fittedSessionRef = useRef<string | null>(null);
  const { fitView } = useReactFlow();

  // 切换会话：清空已见节点集合（新一轮入场动画）并允许重新 FitView
  useEffect(() => {
    prevIdsRef.current = new Set();
    fittedSessionRef.current = null;
    setNodes([]);
    setEdges([]);
  }, [sessionKey, setNodes, setEdges]);

  useEffect(() => {
    if (!graph || graph.nodes.length === 0) {
      layoutSeqRef.current += 1;
      setNodes([]);
      setEdges([]);
      prevIdsRef.current = new Set();
      return;
    }
    const seq = ++layoutSeqRef.current;
    const timer = setTimeout(() => {
      void computeLayout(graph, prevIdsRef.current).then((out) => {
        if (seq !== layoutSeqRef.current) return; // 已有更新的布局请求
        setNodes(out.nodes);
        setEdges(out.edges);
        const freshCount = out.nodes.filter((n) => n.data.fresh).length;
        prevIdsRef.current = new Set(out.nodes.map((n) => n.id));
        // 首次布局或出现了新节点时重新 FitView。
        // fitView 必须等 React 真正把节点渲染出来后再算边界，
        // 双重等待（rAF + timeout）避免「内容挤在角落」的错位。
        const needFit = fittedSessionRef.current !== sessionKey || freshCount > 0;
        if (needFit) {
          fittedSessionRef.current = sessionKey;
          requestAnimationFrame(() => {
            window.setTimeout(() => void fitView(FIT_OPTIONS), 200);
          });
        }
      });
    }, 120);
    return () => clearTimeout(timer);
  }, [graph, sessionKey, setNodes, setEdges, fitView]);

  // 聚焦：悬停优先，其次选中（详情面板打开时）。聚焦点及其邻边保持醒目，其余淡出。
  const focusId = hoverId ?? selectedNodeId ?? null;
  const displayEdges = useMemo(() => {
    if (!focusId) return edges;
    return edges.map((e) => {
      const on = e.source === focusId || e.target === focusId;
      const opacity = on ? 1 : 0.08;
      return {
        ...e,
        style: { ...e.style, opacity },
        labelStyle: e.labelStyle ? { ...e.labelStyle, opacity } : undefined,
        animated: on,
      };
    });
  }, [edges, focusId]);

  const displayNodes = useMemo(() => {
    if (!focusId) return nodes;
    const related = new Set<string>([focusId]);
    for (const e of edges) {
      if (e.source === focusId) related.add(e.target);
      if (e.target === focusId) related.add(e.source);
    }
    return nodes.map((n) => ({
      ...n,
      style: { ...n.style, opacity: related.has(n.id) ? 1 : 0.35 },
    }));
  }, [nodes, edges, focusId]);

  return (
    <ReactFlow
      nodes={displayNodes}
      edges={displayEdges}
      nodeTypes={nodeTypes}
      onNodesChange={onNodesChange}
      onEdgesChange={onEdgesChange}
      onNodeClick={(_, node) => onSelectNode(node.id)}
      onNodeMouseEnter={(_, node) => setHoverId(node.id)}
      onNodeMouseLeave={() => setHoverId(null)}
      onPaneClick={() => onSelectNode(null)}
      fitView
      fitViewOptions={FIT_OPTIONS}
      minZoom={0.15}
      maxZoom={2.2}
      className="af-flow"
    >
      <Background gap={24} size={1.1} color={cssVar('--grid', '#1d1d20')} />
      <Controls showInteractive={false} />
    </ReactFlow>
  );
}

export default function Canvas(props: CanvasProps) {
  return (
    <ReactFlowProvider>
      <CanvasInner {...props} />
    </ReactFlowProvider>
  );
}
