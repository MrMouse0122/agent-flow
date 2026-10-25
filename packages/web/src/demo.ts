/**
 * 离线演示客户端：server 不在线时，用 fixtures 演示数据在本地模拟
 * 与 WS 完全相同的数据路径（同样的 reduceLive reducer），渲染全部功能。
 *
 * - demo-1（demoSession）：创建时开始按 4x 倍速「直播」，播完标记 ended；
 * - demo-2（demoSession2）：作为一个已结束的历史会话，可切换、可回放。
 */
import { buildGraph } from '@agent-flow/inference';
import { demoSession, demoSession2 } from '@agent-flow/protocol';
import { computeDemoDelays, mapDemoTimestamps, summarizeEvents } from './demoScheduler';
import { initialLiveState, reduceLive, type FlowClient, type LiveAction, type LiveState } from './live';

const LIVE_SPEED = 4;
/** 首事件延迟，留出面板渲染时间 */
const FIRST_DELAY_MS = 500;

export class DemoClient implements FlowClient {
  private state: LiveState;
  private listeners = new Set<() => void>();
  private readonly live: typeof demoSession;
  private readonly past: typeof demoSession;
  private readonly liveDelays: number[];
  private liveStarted = false;
  private liveFinished = false;
  private liveIndex = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private destroyed = false;

  constructor() {
    const now = Date.now();
    this.live = mapDemoTimestamps(demoSession, now, LIVE_SPEED);
    // 历史会话：整体放在 3 分钟前
    this.past = mapDemoTimestamps(demoSession2, now - 3 * 60_000, 1);
    this.liveDelays = computeDemoDelays(this.live, 1); // 间隔已在 mapDemoTimestamps 里压缩过
    this.state = reduceLive(initialLiveState, {
      type: 'ws-message',
      msg: {
        type: 'hello',
        sessions: [
          summarizeEvents(this.past, 'ended'),
          summarizeEvents(this.live, 'live', 0),
        ],
      },
    });
  }

  getState = (): LiveState => this.state;

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  };

  /** demo-1 直播中（未播完） */
  get isPlayingLive(): boolean {
    return this.liveStarted && !this.liveFinished;
  }

  /** 开始演示：选中 demo-1 并开始按 4x「直播」 */
  start(): void {
    this.selectSession(this.live[0]?.sessionId ?? null);
  }

  selectSession(sessionId: string | null): void {
    if (!sessionId) {
      this.dispatch({ type: 'select-session', sessionId: null });
      return;
    }
    if (sessionId === this.live[0]?.sessionId) {
      this.dispatch({ type: 'select-session', sessionId });
      if (this.liveFinished) {
        this.pushHistory(sessionId, this.live);
      } else if (this.liveStarted) {
        // 播放中途切走又切回：恢复已播放前缀，后续事件继续实时追加
        this.pushHistory(sessionId, this.live.slice(0, this.liveIndex));
      } else {
        this.startLive();
      }
      return;
    }
    if (sessionId === this.past[0]?.sessionId) {
      this.dispatch({ type: 'select-session', sessionId });
      this.pushHistory(sessionId, this.past);
    }
  }

  destroy(): void {
    this.destroyed = true;
    clearTimeout(this.timer);
    this.listeners.clear();
  }

  private dispatch(action: LiveAction): void {
    const next = reduceLive(this.state, action);
    if (next !== this.state) {
      this.state = next;
      for (const fn of this.listeners) fn();
    }
  }

  private pushHistory(sessionId: string, events: typeof demoSession): void {
    this.dispatch({
      type: 'history',
      sessionId,
      events,
      graph: buildGraph(events),
    });
  }

  private startLive(): void {
    this.liveStarted = true;
    this.scheduleLive(0, FIRST_DELAY_MS);
  }

  private scheduleLive(index: number, delayMs: number): void {
    this.timer = setTimeout(() => {
      if (this.destroyed || index >= this.live.length) return;
      const events = this.live.slice(0, index + 1);
      this.liveIndex = index + 1;
      // 与 server 广播完全同构的消息：event + 当前 graph
      this.dispatch({
        type: 'ws-message',
        msg: { type: 'event', event: this.live[index]!, graph: buildGraph(events) },
      });
      if (this.liveIndex < this.live.length) {
        this.scheduleLive(this.liveIndex, this.liveDelays[this.liveIndex] ?? 0);
      } else {
        this.liveFinished = true;
        this.dispatch({
          type: 'ws-message',
          msg: { type: 'session-end', sessionId: this.live[0]!.sessionId },
        });
      }
    }, delayMs);
  }
}
