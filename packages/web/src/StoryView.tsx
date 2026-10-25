/**
 * 故事线视图：从上往下按时间读「任务是怎么完成的」。
 * 顶部一段大白话总结；下面时间线：提问 → 计划分隔 → 每步（做了什么 + 为什么）→ 完成；
 * 失败标红、紧随其后的步骤标记「补救」。点击任意行打开右侧详情面板。
 */
import { useMemo } from 'react';
import type { Graph } from '@agent-flow/protocol';
import { buildStory } from './story';
import { formatClock } from './util';

const KIND_BADGE: Record<string, { label: string; cls: string }> = {
  prompt: { label: '提问', cls: 'af-kind-prompt' },
  'plan-item': { label: '计划', cls: 'af-kind-plan-item' },
  tool: { label: '工具', cls: 'af-kind-tool' },
  note: { label: 'AI 说明', cls: 'af-kind-note' },
  'turn-end': { label: '完成', cls: 'af-kind-turn-end' },
};

interface StoryViewProps {
  graph: Graph | null;
  onSelectNode: (nodeId: string | null) => void;
}

export default function StoryView({ graph, onSelectNode }: StoryViewProps) {
  const story = useMemo(() => (graph ? buildStory(graph) : null), [graph]);
  if (!story || story.blocks.length === 0) return null;

  return (
    <div className="af-story">
      <div className="af-story-summary">
        <span className="af-story-summary-icon" aria-hidden>
          📖
        </span>
        <p>{story.summary}</p>
      </div>
      <ol className="af-story-list">
        {story.blocks.map(({ step, remediation }) => {
          const badge = KIND_BADGE[step.kind] ?? { label: step.kind, cls: '' };
          if (step.kind === 'plan-item') {
            return (
              <li key={step.id} className="af-story-row af-story-plan">
                <span className={`af-badge ${badge.cls}`}>{badge.label}</span>
                <span className="af-story-plan-title" title={step.label}>
                  {step.label}
                </span>
              </li>
            );
          }
          const why =
            step.why.find((w) => w.source === 'tool-input' && w.text) ??
            step.why.find((w) => w.source === 'plan') ??
            step.why[0];
          return (
            <li
              key={step.id}
              className={`af-story-row af-story-step af-story-${step.status} ${remediation ? 'af-story-remediation' : ''}`}
            >
              <button type="button" className="af-story-btn" onClick={() => onSelectNode(step.id)}>
                <span className={`af-story-dot af-sd-${step.status}`} aria-hidden />
                <span className="af-story-main">
                  <span className="af-story-head">
                    <span className={`af-badge ${badge.cls}`}>{badge.label}</span>
                    {step.tool && <span className="af-story-tool af-mono">{step.tool}</span>}
                    <span className="af-story-title" title={step.label}>
                      {step.label}
                    </span>
                    {remediation && <span className="af-badge af-badge-remediation">补救</span>}
                    <span className="af-story-time af-mono">{formatClock(step.ts)}</span>
                  </span>
                  {why && (
                    <span className="af-story-why" title={why.text}>
                      ↳ {why.text}
                    </span>
                  )}
                </span>
              </button>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
