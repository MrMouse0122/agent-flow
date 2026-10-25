/**
 * 中间画布：Graph → React Flow。
 * - elkjs 布局在 layout.ts 中完成，graph 更新防抖 120ms 重算；
 * - 新节点入场动画（data.fresh + CSS transition）；
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
import { useEffect, useRef } from 'react';
import type { Graph } from '@agent-flow/protocol';
import { computeLayout, type FlowNode } from './layout';

interface CanvasProps {
  graph: Graph | null;
  /** 会话标识变化时重置节点集合并自动 FitView */
  sessionKey: string;
  onSelectNode: (nodeId: string | null) => void;
}

function statusClass(step: { status: string }): string {
  return `af-st-${step.status}`;
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
  const { step, fresh } = data;
  return (
    <div className={`af-node af-plan ${fresh ? 'af-fresh' : ''} ${selected ? 'af-selected' : ''}`}>
      <Handle type="target" position={Position.Top} className="af-handle" />
      <div className="af-plan-header">
        <span className="af-badge af-badge-plan">计划</span>
        <span className="af-plan-title" title={step.label}>
          {step.label}
        </span>
      </div>
      <Handle type="source" position={Position.Bottom} className="af-handle" />
    </div>
  );
}

function ToolNode({ data, selected }: NodeProps<FlowNode>) {
  const { step, fresh } = data;
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
  'af-turnend': TurnEndNode,
};

const FIT_OPTIONS = { padding: 0.18, maxZoom: 1.05, duration: 350 };

function CanvasInner({ graph, sessionKey, onSelectNode }: CanvasProps) {
  const [nodes, setNodes, onNodesChange] = useNodesState<FlowNode>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
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
        prevIdsRef.current = new Set(out.nodes.map((n) => n.id));
        if (fittedSessionRef.current !== sessionKey) {
          fittedSessionRef.current = sessionKey;
          window.setTimeout(() => void fitView(FIT_OPTIONS), 80);
        }
      });
    }, 120);
    return () => clearTimeout(timer);
  }, [graph, sessionKey, setNodes, setEdges, fitView]);

  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      onNodesChange={onNodesChange}
      onEdgesChange={onEdgesChange}
      onNodeClick={(_, node) => onSelectNode(node.id)}
      onPaneClick={() => onSelectNode(null)}
      fitView
      fitViewOptions={FIT_OPTIONS}
      minZoom={0.15}
      maxZoom={2.2}
      className="af-flow"
    >
      <Background gap={24} size={1.1} color="#232937" />
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
