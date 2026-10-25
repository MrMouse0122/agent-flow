#!/usr/bin/env node
'use strict';
/**
 * AgentFlow —— ZCode / Claude Code hook 脚本（零依赖单文件）。
 * 铁律：快进快出（<1s）、异常全吞、永远 exit 0、绝不写 stdout
 * （宿主客户端会把 stdout 按 strict JSON 解析，输出垃圾会污染会话）。
 *
 * 安装器会以 process 型 hook 注册七个事件，事件名通过 argv[2] 传入；
 * 兼容从 payload.hook_event_name 读取。
 */

const http = require('node:http');

const cut = (s, n) => {
  s = String(s == null ? '' : s);
  return s.length > n ? s.slice(0, n) + '…' : s;
};

function describeTool(tool, input) {
  input = input || {};
  switch (tool) {
    case 'Read':
      return '读取 ' + cut(input.file_path || input.path, 80);
    case 'Edit':
      return '修改 ' + cut(input.file_path || input.file_edit_path, 80);
    case 'Write':
      return '写入 ' + cut(input.file_path, 80);
    case 'Bash':
      return '执行 ' + cut(input.command, 40);
    case 'Grep':
      return '搜索 ' + cut(input.pattern, 40);
    case 'Glob':
      return '查找文件 ' + cut(input.pattern, 40);
    case 'Agent':
    case 'Task':
      return '子任务 ' + cut(input.description || input.prompt, 40);
    default:
      return tool || '工具调用';
  }
}

function filesFrom(tool, input) {
  input = input || {};
  const out = [];
  if (typeof input.file_path === 'string') out.push(input.file_path);
  if (typeof input.file_edit_path === 'string') out.push(input.file_edit_path);
  if (Array.isArray(input.files)) {
    for (const f of input.files) if (typeof f === 'string') out.push(f);
  }
  return out.length ? out : undefined;
}

/** payload → AgentEvent（纯函数，供单测） */
function mapPayload(eventName, payload, now) {
  payload = payload || {};
  const sessionId = payload.session_id || process.env.CLAUDE_SESSION_ID || 'zcode-unknown';
  const ts = now || Date.now();
  const id = 'zcode:' + sessionId + ':' + ts.toString(36) + Math.random().toString(36).slice(2, 8);
  const mk = (phase, extra) =>
    Object.assign({ id, ts, sessionId, adapter: 'zcode', phase, title: '' }, extra);
  const tool = payload.tool_name;
  switch (eventName) {
    case 'SessionStart':
      return mk('note', { title: '会话开始' });
    case 'UserPromptSubmit':
      return mk('user_prompt', {
        title: '用户：' + cut(payload.prompt, 60),
        input: { prompt: payload.prompt },
      });
    case 'PermissionRequest':
      return mk('note', { tool, title: '等待授权：' + (tool || '工具') });
    case 'PreToolUse':
      return mk('tool_start', {
        tool,
        title: describeTool(tool, payload.tool_input),
        files: filesFrom(tool, payload.tool_input),
        input: payload.tool_input,
      });
    case 'PostToolUse':
      return mk('tool_end', {
        tool,
        title: describeTool(tool, payload.tool_input),
        files: filesFrom(tool, payload.tool_input),
        input: payload.tool_input,
        output: payload.tool_response,
        status: 'ok',
      });
    case 'PostToolUseFailure':
      return mk('tool_end', {
        tool,
        title: describeTool(tool, payload.tool_input),
        files: filesFrom(tool, payload.tool_input),
        input: payload.tool_input,
        output: payload.tool_response,
        status: 'error',
      });
    case 'Stop':
      return mk('turn_end', { title: '本轮完成' });
    default:
      return null;
  }
}

function post(ev, port, cb) {
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
      res.on('end', cb);
    }
  );
  req.on('error', cb);
  req.on('timeout', () => {
    req.destroy();
    cb();
  });
  req.end(body);
}

if (require.main === module) {
  const port = Number(process.env.AGENT_FLOW_PORT || 4765);
  let data = '';
  let done = false;
  const finish = (payload) => {
    if (done) return;
    done = true;
    try {
      if (!payload) return process.exit(0);
      const eventName = process.argv[2] || payload.hook_event_name;
      const ev = eventName ? mapPayload(eventName, payload) : null;
      if (!ev) return process.exit(0);
      post(ev, port, () => process.exit(0));
    } catch {
      process.exit(0);
    }
  };
  const stdinTimer = setTimeout(() => finish(null), 300); // stdin 迟迟不结束也退出
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (c) => (data += c));
  process.stdin.on('end', () => {
    clearTimeout(stdinTimer);
    let payload = null;
    try {
      payload = JSON.parse(data);
    } catch {
      payload = null;
    }
    finish(payload);
  });
  process.stdin.on('error', () => finish(null));
  setTimeout(() => process.exit(0), 1000).unref(); // 总时限兜底
}

module.exports = { mapPayload, describeTool, filesFrom };
