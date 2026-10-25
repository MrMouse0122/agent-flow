#!/usr/bin/env node
'use strict';
/**
 * AgentFlow —— Codex CLI notify 回调脚本（零依赖单文件）。
 * Codex 把一个 JSON 字符串作为 argv[2] 传进来；映射为 turn_end 事件 POST 给 server。
 * 铁律同 hook.cjs：快进快出、异常全吞、exit 0、不写 stdout。
 */

const http = require('node:http');

function notifyToEvent(argvJson, now) {
  let j = null;
  try {
    j = JSON.parse(String(argvJson == null ? '' : argvJson));
  } catch {
    return null;
  }
  if (!j || typeof j !== 'object') return null;
  const sessionId = (typeof j.session_id === 'string' && j.session_id) || 'codex-unknown';
  const ts = now || Date.now();
  return {
    id: 'codex:' + sessionId + ':notify' + ts.toString(36) + Math.random().toString(36).slice(2, 6),
    ts,
    sessionId,
    adapter: 'codex',
    phase: 'turn_end',
    title: 'Codex 本轮完成',
  };
}

if (require.main === module) {
  const port = Number(process.env.AGENT_FLOW_PORT || 4765);
  const ev = notifyToEvent(process.argv[2]);
  if (!ev) process.exit(0);
  const body = JSON.stringify({ events: [ev] });
  const req = http.request(
    {
      host: '127.0.0.1',
      port,
      path: '/api/events',
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
      timeout: 800,
    },
    (res) => {
      res.resume();
      res.on('end', () => process.exit(0));
    }
  );
  req.on('error', () => process.exit(0));
  req.on('timeout', () => {
    req.destroy();
    process.exit(0);
  });
  req.end(body);
}

module.exports = { notifyToEvent };
