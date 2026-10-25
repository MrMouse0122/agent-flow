/**
 * 故事线视图（小白友好版）：从上往下按时间读「任务是怎么完成的」。
 * 顶部大白话总结；步骤行 = 序号 + 做了什么 + ↑ 承接上一步 + ↳ 为什么 + ● 结果；
 * 失败标红、补救打标记。点击任意行打开右侧详情面板。
 */
import { useMemo } from 'react';
import type { AgentEvent, Graph } from '@agent-flow/protocol';
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
  events: AgentEvent[];
  onSelectNode: (nodeId: string | null) => void;
}

export default function StoryView({ graph, events, onSelectNode }: StoryViewProps) {
  const story = useMemo(() => (graph ? buildStory(graph, events) : null), [graph, events]);
  if (!story || story.blocks.length === 0) return null;

  return (
    <div className="af-story">
      <div className="af-story-summary">
        <span className="af-story-summary-mark">任务回顾</span>
        <div>
          <p>{story.summary}</p>
          <p className="af-story-legend">
            每一步从上到下按时间排列：「联系」是与上一步的关系，「原因」是为什么这么做，「结果」是这一步的产出。点击任意步骤可看完整详情。
          </p>
        </div>
      </div>
      <ol className="af-story-list">
        {story.blocks.map((b) => {
          const badge = KIND_BADGE[b.step.kind] ?? { label: b.step.kind, cls: '' };
          if (b.step.kind === 'plan-item') {
            const plan = b as { actionCount?: number; planIndex?: number };
            return (
              <li key={b.step.id} className="af-story-row af-story-plan">
                <span className={`af-badge ${badge.cls}`}>计划 {plan.planIndex}</span>
                <span className="af-story-plan-title" title={b.step.label}>
                  {b.step.label}
                </span>
                {!!plan.actionCount && <span className="af-story-plan-meta">{plan.actionCount} 个动作</span>}
              </li>
            );
          }
          const why =
            b.step.why.find((w) => w.source === 'tool-input' && w.text) ??
            b.step.why.find((w) => w.source === 'plan') ??
            b.step.why[0];
          return (
            <li
              key={b.step.id}
              className={`af-story-row af-story-step af-story-${b.step.status} ${b.remediation ? 'af-story-remediation' : ''}`}
            >
              <button type="button" className="af-story-btn" onClick={() => onSelectNode(b.step.id)}>
                <span className={`af-story-dot af-sd-${b.step.status}`} aria-hidden />
                <span className="af-story-main">
                  <span className="af-story-head">
                    <span className={`af-badge ${badge.cls}`}>{badge.label}</span>
                    {b.step.tool && <span className="af-story-tool af-mono">{b.step.tool}</span>}
                    <span className="af-story-title" title={b.step.label}>
                      {typeof b.index === 'number' ? `${b.index}. ` : ''}
                      {b.step.label}
                    </span>
                    {b.remediation && <span className="af-badge af-badge-remediation">补救</span>}
                    <span className="af-story-time af-mono">{formatClock(b.step.ts)}</span>
                  </span>
                  {b.connect && (
                    <span className="af-story-connect" title={b.connect}>
                      联系：{b.connect}
                    </span>
                  )}
                  {why && (
                    <span className="af-story-why" title={why.text}>
                      原因：{why.text}
                    </span>
                  )}
                  {b.result && (
                    <span className={`af-story-result ${b.step.status === 'error' ? 'af-story-result-error' : ''}`}>
                      结果：{b.result}
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
