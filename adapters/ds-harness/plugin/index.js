/**
 * AgentFlow telemetry 插件 —— DeepSeek Harness（dsh）官方姿势接入。
 *
 * dsh 的插件是 Cordis 模块（{ name, inject, apply(ctx) }），通过 ctx.on 订阅
 * 事件总线；UI 层正是靠监听 session/event（持久事实域）完整复现会话的。
 * 本插件做同一件事：把会话事件流翻译成 AgentEvent，POST 给 AgentFlow server
 * （默认 http://127.0.0.1:4765）。铁律：telemetry 绝不干扰宿主——任何异常
 * 全部吞掉，事件去重交给 server（id = dsh:<sessionId>:<seq>，天然幂等）。
 *
 * 挂载方式见包目录 README.md。
 */
import { request } from 'node:http';
import { mapDshEvent } from './mapper.js';

export const name = 'agent-flow-telemetry';
export const inject = []; // 不依赖任何 dsh 服务；事件订阅走 ctx.on

/** 从订阅回调的载荷里尽力提取 { sessionId, record }：不同版本形状有差异 */
function extractPayload(payload) {
  if (!payload || typeof payload !== 'object') return null;
  // 形态 A：{ sessionId, event: { seq, time, type, data } }
  if (payload.event && typeof payload.event === 'object') {
    return {
      sessionId: payload.sessionId ?? payload.session?.id ?? payload.event.sessionId,
      record: payload.event,
    };
  }
  // 形态 B：{ session: { id }, record: {...} } / 形态 C：事件本体直接携带 sessionId
  const record = payload.record ?? payload;
  const sessionId = payload.sessionId ?? payload.session?.id ?? record.sessionId;
  if (!record || typeof record !== 'object' || typeof record.type !== 'string') return null;
  return { sessionId, record };
}

function postEvents(events, port) {
  const body = JSON.stringify({ events });
  const req = request(
    {
      host: '127.0.0.1',
      port,
      path: '/api/events',
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
      timeout: 800,
    },
    (res) => res.resume()
  );
  req.on('error', () => {});
  req.on('timeout', () => req.destroy());
  req.end(body);
}

export function apply(ctx) {
  const port = Number(process.env.AGENT_FLOW_PORT || 4765);
  let buffered = [];
  let flushTimer;

  const flush = () => {
    flushTimer = undefined;
    if (buffered.length === 0) return;
    const batch = buffered;
    buffered = [];
    try {
      postEvents(batch, port);
    } catch {
      /* server 不在线：丢弃（server 端 JSONL 存档不受影响） */
    }
  };
  const enqueue = (ev) => {
    buffered.push(ev);
    // 250ms 合并一批：事件密集时减少请求数，又不至于拖慢实时性
    if (!flushTimer) flushTimer = setTimeout(flush, 250);
  };

  // ctx.on 返回 Cordis disposer，插件卸载时框架自动反订阅
  ctx.on('session/event', (payload) => {
    try {
      const extracted = extractPayload(payload);
      if (!extracted) return;
      const ev = mapDshEvent(extracted.record, extracted.sessionId);
      if (ev) enqueue(ev);
    } catch {
      /* 任何映射异常都不允许影响 dsh 会话 */
    }
  });
}
