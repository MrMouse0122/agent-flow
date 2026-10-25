/**
 * 右侧详情面板（点节点滑入）：
 * label / kind / tool / status / 时间、why 来源徽章、input/output 折叠 JSON 树、files、eventIds。
 * input/output 不在 StepNode 里，按 eventIds 回当前会话事件中取。
 */
import type { AgentEvent, StepNode } from '@agent-flow/protocol';
import JsonTree from './JsonTree';
import { formatClock } from './util';

const KIND_LABEL: Record<string, string> = {
  prompt: '提问',
  'plan-item': '计划条目',
  tool: '工具',
  'turn-end': '回合结束',
  note: 'AI 说明',
};

const STATUS_LABEL: Record<string, string> = {
  running: '运行中',
  ok: '成功',
  error: '失败',
  pending: '等待中',
};

const WHY_META: Record<string, { label: string; className: string }> = {
  user: { label: '用户需求', className: 'af-badge-user' },
  plan: { label: '计划', className: 'af-badge-plan' },
  'tool-input': { label: '工具输入', className: 'af-badge-toolinput' },
  unknown: { label: '未知', className: 'af-badge-unknown' },
};

function pickPayload(events: AgentEvent[], want: 'input' | 'output'): unknown {
  const key = want;
  let found: unknown;
  for (const ev of events) {
    const v = ev[key];
    if (v !== null && v !== undefined) found = v;
  }
  return found;
}

interface DetailPanelProps {
  step: StepNode | null;
  events: AgentEvent[];
  onClose: () => void;
}

export default function DetailPanel({ step, events, onClose }: DetailPanelProps) {
  const related = step ? events.filter((e) => step.eventIds.includes(e.id)) : [];
  const input = pickPayload(related, 'input');
  const output = pickPayload(related, 'output');

  return (
    <aside className={`af-detail ${step ? 'af-detail-open' : ''}`} aria-hidden={!step}>
      {step && (
        <>
          <header className="af-detail-header">
            <div className="af-detail-titlewrap">
              <span className={`af-badge af-kind-${step.kind}`}>{KIND_LABEL[step.kind] ?? step.kind}</span>
              <h2 className="af-detail-title" title={step.label}>
                {step.label}
              </h2>
            </div>
            <button type="button" className="af-icon-btn" onClick={onClose} aria-label="关闭详情">
              ×
            </button>
          </header>

          <div className="af-detail-body">
            <section className="af-meta">
              {step.tool && (
                <div className="af-meta-row">
                  <span className="af-meta-label">工具</span>
                  <span className="af-meta-value af-mono">{step.tool}</span>
                </div>
              )}
              <div className="af-meta-row">
                <span className="af-meta-label">状态</span>
                <span className={`af-meta-value`}>
                  <span className={`af-status-chip af-status-${step.status}`}>
                    <span className="af-status-dot" />
                    {STATUS_LABEL[step.status] ?? step.status}
                  </span>
                </span>
              </div>
              <div className="af-meta-row">
                <span className="af-meta-label">时间</span>
                <span className="af-meta-value af-mono">{formatClock(step.ts)}</span>
              </div>
            </section>

            <section className="af-detail-section">
              <h3 className="af-section-title">为什么做这一步</h3>
              {step.why.length === 0 ? (
                <div className="af-empty-note">（无依据记录）</div>
              ) : (
                <ul className="af-why-list">
                  {step.why.map((w, i) => {
                    const meta = WHY_META[w.source] ?? WHY_META.unknown!;
                    return (
                      <li key={i} className="af-why-item">
                        <span className={`af-badge ${meta.className}`}>{meta.label}</span>
                        <span className="af-why-text" title={w.text}>
                          {w.text}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              )}
            </section>

            <section className="af-detail-section">
              <h3 className="af-section-title">输入</h3>
              <JsonTree value={input} />
            </section>

            <section className="af-detail-section">
              <h3 className="af-section-title">输出</h3>
              <JsonTree value={output} />
            </section>

            {step.files && step.files.length > 0 && (
              <section className="af-detail-section">
                <h3 className="af-section-title">相关文件</h3>
                <ul className="af-files">
                  {step.files.map((f) => (
                    <li key={f} className="af-file af-mono" title={f}>
                      {f}
                    </li>
                  ))}
                </ul>
              </section>
            )}

            <section className="af-detail-section">
              <h3 className="af-section-title">关联事件</h3>
              <div className="af-eventids">
                {step.eventIds.map((id) => (
                  <span key={id} className="af-eventid af-mono" title={id}>
                    {id}
                  </span>
                ))}
              </div>
            </section>
          </div>
        </>
      )}
    </aside>
  );
}
