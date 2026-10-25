/**
 * DeepSeek Harness（dsh）会话事件 → AgentEvent 纯映射。
 *
 * dsh 的会话是「事件溯源日志」：一切模型可见的输入都会追加进不可变日志，
 * 信封形如 { seq, time, type, data }（seq 单调递增，UI 就靠重放它复现会话）。
 * 官方文档记载的会话事件类型（docs/architecture.md turn flow）：
 *   turn/start | turn/end | step/start | step/end
 *   user/message | assistant/message | tool/call | tool/result | todo/write
 *
 * 字段名以官方文档与社区教程为参照实现；dsh 处于 Developer Preview
 * （0.1.0-rc.x，官方预告可能有破坏性变更），接入真实环境若字段对不上，
 * 只需调整本文件——插件的订阅与上报逻辑不用动。
 */

const cut = (s, n) => (s.length > n ? s.slice(0, n) + '…' : s);

/** time 兼容 ISO 字符串 / 毫秒 / 秒；解析不出回退 now */
function tsOf(v, now) {
  if (typeof v === 'string') {
    const ms = Date.parse(v);
    if (Number.isFinite(ms)) return ms;
  }
  if (typeof v === 'number' && Number.isFinite(v)) {
    if (v > 1e12) return v; // 毫秒
    if (v > 1e9) return v * 1000; // 秒
  }
  return now;
}

/** data 里尽力找文本：text / message / content / prompt */
function textOf(data) {
  if (!data || typeof data !== 'object') return undefined;
  for (const key of ['text', 'message', 'content', 'prompt']) {
    const v = data[key];
    if (typeof v === 'string' && v.trim()) return v;
    if (Array.isArray(v)) {
      const parts = v
        .map((c) => (typeof c === 'string' ? c : c && typeof c === 'object' && typeof c.text === 'string' ? c.text : ''))
        .filter(Boolean);
      if (parts.length) return parts.join('\n');
    }
  }
  return undefined;
}

/** tool/call 的参数：raw arguments 是 JSON 字符串（官方教程特别提醒要 parse），兼容对象形态 */
function argsOf(raw) {
  if (typeof raw === 'string' && raw.trim()) {
    try {
      const v = JSON.parse(raw);
      return v && typeof v === 'object' && !Array.isArray(v) ? v : { _raw: raw };
    } catch {
      return { _raw: raw };
    }
  }
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
}

const commandText = (args) => {
  const c = args.command;
  if (typeof c === 'string' && c) return c;
  if (Array.isArray(c) && c.length > 0) return c.map((x) => String(x)).join(' ');
  return undefined;
};

const fileOf = (args) =>
  typeof args.file_path === 'string' ? args.file_path : typeof args.path === 'string' ? args.path : undefined;

/** todo/write 的条目 → 字符串数组（条目可能是字符串或 {content|text|title} 对象） */
function planItemsOf(data) {
  const list = data && (data.todos ?? data.items ?? data.list);
  if (!Array.isArray(list)) return null;
  const items = list
    .map((it) => {
      if (typeof it === 'string') return it;
      if (it && typeof it === 'object') {
        for (const key of ['content', 'text', 'title', 'description']) {
          if (typeof it[key] === 'string' && it[key]) return it[key];
        }
      }
      return '';
    })
    .filter(Boolean);
  return items.length > 0 ? items : null;
}

/**
 * 一条 dsh 会话事件 → AgentEvent | null。
 * @param record  { seq, time, type, data } 信封（缺 seq/time 时有兜底）
 * @param sessionId dsh 会话 id（插件从会话上下文取得后传入）
 * @param now     time 解析失败时的时间兜底（测试注入用）
 */
export function mapDshEvent(record, sessionId, now = Date.now()) {
  if (!record || typeof record !== 'object') return null;
  const r = record;
  const type = typeof r.type === 'string' ? r.type : '';
  const data = (r.data ?? {}) ?? {};
  const ts = tsOf(r.time, now);
  const seq = typeof r.seq === 'number' && Number.isFinite(r.seq) ? r.seq : `${ts}`;
  const sid = sessionId || 'dsh-unknown';
  const mk = (phase, extra) => ({
    id: `dsh:${sid}:${seq}`,
    ts,
    sessionId: sid,
    adapter: 'ds-harness',
    phase,
    title: '',
    ...extra,
  });

  switch (type) {
    case 'user/message': {
      const text = textOf(data);
      if (!text) return null;
      return mk('user_prompt', { title: '用户：' + cut(text, 60), input: { prompt: text } });
    }
    case 'assistant/message': {
      const text = textOf(data);
      if (!text) return null;
      return mk('note', { title: cut(text, 60) });
    }
    case 'tool/call': {
      const tool = (typeof data.tool === 'string' && data.tool) || (typeof data.name === 'string' && data.name) || data.toolName || 'tool';
      const args = argsOf(data.arguments ?? data.input ?? data.args);
      const command = commandText(args);
      const file = fileOf(args);
      return mk('tool_start', {
        tool,
        title: command ? `执行 ${cut(command, 40)}` : file ? `${tool} ${cut(file, 60)}` : `调用 ${tool}`,
        files: file ? [file] : undefined,
        input: Object.keys(args).length > 0 ? args : undefined,
      });
    }
    case 'tool/result': {
      const tool = (typeof data.tool === 'string' && data.tool) || (typeof data.name === 'string' && data.name) || data.toolName || undefined;
      const failed = data.error !== undefined && data.error !== null && data.error !== false ? true : data.isError === true || data.ok === false;
      return mk('tool_end', {
        tool,
        title: typeof tool === 'string' ? `${tool} 完成` : '工具执行完成',
        output: data.result ?? data.output ?? undefined,
        status: failed ? 'error' : 'ok',
      });
    }
    case 'todo/write': {
      const items = planItemsOf(data);
      if (!items) return null;
      return mk('plan', { title: `任务清单更新（${items.length} 项）`, planItems: items });
    }
    case 'turn/end': {
      const kind = typeof data.kind === 'string' ? data.kind : '';
      const failed = kind === 'error' || kind === 'blocked' || kind === 'aborted';
      return mk('turn_end', { title: failed ? `dsh 本轮结束（${kind}）` : 'dsh 本轮完成', status: failed ? 'error' : 'ok' });
    }
    default:
      return null; // turn/start、step/* 等过程信号不造节点
  }
}
