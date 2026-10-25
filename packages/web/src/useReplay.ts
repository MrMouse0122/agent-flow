/**
 * 回放控制器：滑杆 = 事件序号 0..N。
 * engaged=false（实时模式）时始终跟随尾部；engaged=true 时冻结/按播放速度推进，
 * 每步本地 buildGraph(events.slice(0, i)) 重算渲染。
 */
import { buildGraph } from '@agent-flow/inference';
import type { AgentEvent, Graph } from '@agent-flow/protocol';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

export type ReplaySpeed = 1 | 2 | 4;

/** 每个事件的基础播放间隔（1x）——要让人来得及看清每一步的变化 */
const STEP_MS = 1100;

export interface ReplayController {
  /** 已包含的事件数（0..N），即滑杆值 */
  index: number;
  playing: boolean;
  speed: ReplaySpeed;
  /** 回放模式下本地重算的图；实时模式为 null（用 server/演示推送的图） */
  graph: Graph | null;
  setIndex: (i: number) => void;
  toggle: () => void;
  setSpeed: (s: ReplaySpeed) => void;
}

export function useReplay(events: AgentEvent[], engaged: boolean): ReplayController {
  const [index, setIndexState] = useState(events.length);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeedState] = useState<ReplaySpeed>(1);
  const timerRef = useRef<number | undefined>(undefined);

  // 实时模式：始终跟随最新事件
  useEffect(() => {
    if (!engaged) {
      setPlaying(false);
      setIndexState(events.length);
    }
  }, [engaged, events.length]);

  // 事件列表变短（切换会话）时收敛索引
  useEffect(() => {
    setIndexState((i) => Math.min(i, events.length));
  }, [events.length]);

  useEffect(() => {
    if (!playing || !engaged) return;
    if (index >= events.length) {
      setPlaying(false);
      return;
    }
    timerRef.current = window.setTimeout(() => {
      setIndexState((i) => Math.min(i + 1, events.length));
    }, STEP_MS / speed);
    return () => window.clearTimeout(timerRef.current);
  }, [playing, engaged, index, events.length, speed]);

  useEffect(() => () => window.clearTimeout(timerRef.current), []);

  const graph = useMemo(
    () => (engaged ? buildGraph(events.slice(0, index)) : null),
    [engaged, events, index],
  );

  const setIndex = useCallback((i: number) => {
    setPlaying(false);
    setIndexState(Math.max(0, Math.min(i, Number.MAX_SAFE_INTEGER)));
  }, []);

  const toggle = useCallback(() => {
    setPlaying((p) => {
      if (!p && index >= events.length) setIndexState(0); // 播完后再按播放：从头开始
      return !p;
    });
  }, [index, events.length]);

  const setSpeed = useCallback((s: ReplaySpeed) => setSpeedState(s), []);

  return { index, playing, speed, graph, setIndex, toggle, setSpeed };
}
