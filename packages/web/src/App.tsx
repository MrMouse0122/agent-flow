/**
 * 三栏布局：左侧会话栏 / 中间画布 / 右侧详情面板（滑入），顶栏为会话与回放控制。
 * 数据源二选一：LiveClient（WS 实时）或 DemoClient（离线演示），二者共用同一 reducer 数据路径。
 */
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import Canvas from './Canvas';
import { DemoClient } from './demo';
import DetailPanel from './DetailPanel';
import { LiveClient, initialLiveState } from './live';
import type { FlowClient, LiveState } from './live';
import StoryView from './StoryView';
import { useReplay } from './useReplay';
import { formatRelative } from './util';

const ADAPTER_LABEL: Record<string, string> = {
  zcode: 'ZCode',
  codex: 'Codex',
  'ds-harness': 'DS-Harness',
  generic: '通用',
  demo: '演示',
};

function useClientState(client: FlowClient | null): LiveState {
  const subscribe = useCallback(
    (fn: () => void) => (client ? client.subscribe(fn) : () => {}),
    [client],
  );
  const getSnapshot = useCallback(() => (client ? client.getState() : initialLiveState), [client]);
  return useSyncExternalStore(subscribe, getSnapshot);
}

type Theme = 'light' | 'dark';

export default function App() {
  const [liveClient, setLiveClient] = useState<LiveClient | null>(null);
  const [demoClient, setDemoClient] = useState<DemoClient | null>(null);
  const [theme, setTheme] = useState<Theme>(() =>
    typeof localStorage !== 'undefined' && localStorage.getItem('af-theme') === 'dark' ? 'dark' : 'light',
  );

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem('af-theme', theme);
    } catch {
      /* 隐私模式等场景忽略 */
    }
  }, [theme]);

  useEffect(() => {
    const c = new LiveClient();
    setLiveClient(c);
    return () => c.destroy();
  }, []);

  const usingDemo = demoClient !== null;
  const client: FlowClient | null = usingDemo ? demoClient : liveClient;
  const state = useClientState(client);

  // 首次拿到会话列表时自动选中最近的一个
  const autoPickedRef = useRef(false);
  useEffect(() => {
    if (autoPickedRef.current || usingDemo || !client) return;
    if (state.sessions.length > 0) {
      autoPickedRef.current = true;
      client.selectSession(state.sessions[0]!.sessionId);
    }
  }, [state.sessions, client, usingDemo]);

  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<'live' | 'replay'>('live');
  const [storyMode, setStoryMode] = useState(true);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 15_000);
    return () => window.clearInterval(t);
  }, []);

  const currentSession = useMemo(
    () => state.sessions.find((s) => s.sessionId === state.currentSessionId) ?? null,
    [state.sessions, state.currentSessionId],
  );
  const sortedSessions = useMemo(
    () => [...state.sessions].sort((a, b) => b.lastTs - a.lastTs),
    [state.sessions],
  );

  // 切换会话：清选择、退出回放模式
  useEffect(() => {
    setSelectedNodeId(null);
    setViewMode('live');
  }, [state.currentSessionId]);

  const replay = useReplay(state.events, viewMode === 'replay');
  const displayGraph = replay.graph ?? state.graph;
  const selectedStep = displayGraph?.nodes.find((n) => n.id === selectedNodeId) ?? null;

  const showDemoButton = !usingDemo && (state.conn !== 'connected' || state.sessions.length === 0);

  const startDemo = useCallback(() => {
    if (demoClient) return;
    const c = new DemoClient();
    setDemoClient(c);
    c.start();
  }, [demoClient]);

  const exitDemo = useCallback(() => {
    demoClient?.destroy();
    setDemoClient(null);
    setSelectedNodeId(null);
    setViewMode('live');
  }, [demoClient]);

  const hasEvents = currentSession !== null && state.events.length > 0;

  return (
    <div className="af-app">
      <header className="af-topbar">
        <div className="af-topbar-left">
          <span
            className={`af-chip ${currentSession?.status === 'live' ? 'af-chip-live' : 'af-chip-ended'}`}
          >
            {currentSession ? (currentSession.status === 'live' ? '实时' : '已结束') : '未选会话'}
          </span>
          <h1 className="af-topbar-title" title={currentSession?.title ?? undefined}>
            {currentSession?.title ?? 'AgentFlow'}
          </h1>
        </div>
        <div className="af-topbar-right">
          {hasEvents && (
            <div className="af-viewtoggle" role="group" aria-label="视图切换">
              <button
                type="button"
                className={`af-btn ${storyMode ? 'af-btn-active' : ''}`}
                onClick={() => setStoryMode(true)}
              >
                故事线
              </button>
              <button
                type="button"
                className={`af-btn ${!storyMode ? 'af-btn-active' : ''}`}
                onClick={() => setStoryMode(false)}
              >
                流程图
              </button>
            </div>
          )}
          {hasEvents &&
            (viewMode === 'live' ? (
              currentSession!.status === 'live' ? (
                <button type="button" className="af-btn" onClick={() => setViewMode('replay')}>
                  暂停实时
                </button>
              ) : (
                <button type="button" className="af-btn" onClick={() => setViewMode('replay')}>
                  回放此会话
                </button>
              )
            ) : (
              <div className="af-replay-bar">
                <button
                  type="button"
                  className="af-btn af-btn-icon"
                  onClick={replay.toggle}
                  title={replay.playing ? '暂停回放' : '播放回放'}
                    >
                      {replay.playing ? '暂停' : '播放'}
                    </button>
                <input
                  className="af-slider"
                  type="range"
                  min={0}
                  max={state.events.length}
                  step={1}
                  value={Math.min(replay.index, state.events.length)}
                  onChange={(e) => replay.setIndex(Number(e.target.value))}
                  aria-label="回放进度"
                />
                <span className="af-replay-count af-mono">
                  {Math.min(replay.index, state.events.length)}/{state.events.length}
                </span>
                <div className="af-speed" role="group" aria-label="回放速度">
                  {([1, 2, 4] as const).map((s) => (
                    <button
                      key={s}
                      type="button"
                      className={`af-speed-btn ${replay.speed === s ? 'af-speed-active' : ''}`}
                      onClick={() => replay.setSpeed(s)}
                    >
                      {s}x
                    </button>
                  ))}
                </div>
                <button type="button" className="af-btn af-btn-ghost" onClick={() => setViewMode('live')}>
                  回到实时
                </button>
              </div>
            ))}
        </div>
      </header>

      <div className="af-main">
        <aside className="af-sidebar">
          <div className="af-brand">
            <span className="af-brand-name">AgentFlow</span>
            <span className={`af-conn af-conn-${state.conn}`}>
              <span className="af-conn-dot" />
              {state.conn === 'connected' ? '已连接' : state.conn === 'reconnecting' ? '连接中' : '未连接'}
            </span>
          </div>

          <div className="af-sidebar-label">会话</div>
          <ul className="af-session-list">
            {sortedSessions.map((s) => (
              <li key={s.sessionId}>
                <button
                  type="button"
                  className={`af-session ${s.sessionId === state.currentSessionId ? 'af-session-active' : ''}`}
                  onClick={() => client?.selectSession(s.sessionId)}
                >
                  <div className="af-session-title" title={s.title}>
                    {s.title}
                  </div>
                  <div className="af-session-meta">
                    <span className={`af-badge af-badge-adapter af-adapter-${s.adapter}`}>
                      {ADAPTER_LABEL[s.adapter] ?? s.adapter}
                    </span>
                    <span className={`af-session-status ${s.status === 'live' ? 'af-status-live' : 'af-status-ended'}`}>
                      {s.status === 'live' ? '直播中' : '已结束'}
                    </span>
                    <span className="af-session-time">{formatRelative(s.lastTs, now)}</span>
                  </div>
                </button>
              </li>
            ))}
            {sortedSessions.length === 0 && (
              <li className="af-session-empty">
                {state.conn === 'connected'
                  ? '暂无会话——在 Agent 客户端里发起对话试试'
                  : '正在等待服务器连接…'}
              </li>
            )}
          </ul>

          <div className="af-sidebar-foot">
            <button
              type="button"
              className="af-btn af-btn-ghost"
              onClick={() => setTheme((t) => (t === 'dark' ? 'light' : 'dark'))}
            >
              {theme === 'dark' ? '切换浅色' : '切换深色'}
            </button>
            {usingDemo ? (
              <>
                <div className="af-demo-note">离线演示模式</div>
                <button type="button" className="af-btn af-btn-ghost" onClick={exitDemo}>
                  退出演示
                </button>
              </>
            ) : (
              showDemoButton && (
                <button type="button" className="af-btn af-btn-demo" onClick={startDemo}>
                  加载演示会话
                </button>
              )
            )}
          </div>
        </aside>

        <main className="af-canvas-wrap">
          {currentSession ? (
            <>
              {storyMode ? (
                <StoryView graph={displayGraph} events={state.events} onSelectNode={setSelectedNodeId} />
              ) : (
                <Canvas
                  key={`${state.currentSessionId ?? 'none'}-${theme}`}
                  graph={displayGraph}
                  sessionKey={state.currentSessionId ?? 'none'}
                  selectedNodeId={selectedNodeId}
                  onSelectNode={setSelectedNodeId}
                />
              )}
              {(!displayGraph || displayGraph.nodes.length === 0) && (
                <div className="af-canvas-hint">
                  {viewMode === 'replay' && replay.index === 0
                    ? '拖动滑杆或按「播放」开始回放'
                    : '等待事件流入…'}
                </div>
              )}
            </>
          ) : (
            <div className="af-canvas-placeholder">
              <span className="af-placeholder-mark" aria-hidden />
              <p>选择左侧会话，或从任一已接入的 Agent 客户端发起对话</p>
              {showDemoButton && (
                <button type="button" className="af-btn af-btn-demo" onClick={startDemo}>
                  加载演示会话
                </button>
              )}
            </div>
          )}
        </main>

        <DetailPanel step={selectedStep} events={state.events} onClose={() => setSelectedNodeId(null)} />
      </div>
    </div>
  );
}
