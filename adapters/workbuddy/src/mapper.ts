/**
 * WorkBuddy 审计数据 → AgentEvent 纯映射（无 IO，可单测）。
 * 数据源均为本机只读文件（`~/.workbuddy/`，实测 v1.x 格式）：
 *  - audit-log/<YYYY-MM-DD>.jsonl  追加式审计日志（哈希链），每行含 eventType/messageKey/messageParams
 *  - changes-index/<sessionId>.json 变更索引（整文件重写），记录写文件动作与路径
 *  - <profile>/sidebar-list-snapshot.json 会话标题快照
 * 事件 id 全部取自记录自带标识（uuid / change.id），重启重读天然幂等。
 */
import type { AgentEvent } from '@agent-flow/protocol';

const cut = (s: string, n: number) => (s.length > n ? s.slice(0, n) + '…' : s);

const basename = (p: string) => p.split(/[\\/]/).pop() ?? p;

/** paths/targets 字段可能是单路径或逗号/分号/换行分隔的多路径 */
function splitPaths(v: unknown): string[] {
  if (typeof v !== 'string' || !v.trim()) return [];
  return v
    .split(/[,;\n]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** messageKey 尾段推断文件动作：…readWithRule / …writeWithRule / …bulkDelete.approved */
function fileToolOf(messageKey: string): string {
  if (/delete/i.test(messageKey)) return 'Bash';
  if (/write|edit|create/i.test(messageKey)) return 'Write';
  return 'Read';
}

const titleOf = (tool: string | undefined, paths: string[]): string => {
  const toolName = tool === 'Bash' ? '删除' : tool === 'Write' ? '写入' : tool === 'Edit' ? '修改' : '读取';
  if (paths.length === 0) return toolName + ' 文件';
  if (paths.length === 1) return `${toolName} ${cut(basename(paths[0]!), 60)}`;
  return `${toolName} ${paths.length} 个文件`;
};

/** audit-log 单行 → 0 或 1 个 AgentEvent。now 仅在记录缺 timestamp 时兜底。 */
export function mapAuditRecord(rec: unknown, now = Date.now()): AgentEvent | null {
  if (!rec || typeof rec !== 'object') return null;
  const r = rec as Record<string, unknown>;
  if (typeof r.eventType !== 'string' || !r.eventType) return null; // manifest 行（segment-closed 等）
  const eventType = r.eventType;
  if (eventType.startsWith('config.')) return null; // 配置迁移等与执行过程无关

  const sessionId = typeof r.sessionId === 'string' && r.sessionId ? r.sessionId : 'workbuddy-unknown';
  const id = typeof r.id === 'string' && r.id ? `wb:aud:${r.id}` : `wb:aud:${sessionId}:${String(r.sequence ?? now)}`;
  const ts = typeof r.timestamp === 'number' && Number.isFinite(r.timestamp) ? r.timestamp : now;
  const decision = typeof r.decision === 'string' ? r.decision : '';
  const status = decision && decision !== 'allowed' ? ('error' as const) : ('ok' as const);
  const params = (r.messageParams ?? {}) as Record<string, unknown>;
  const messageKey = typeof r.messageKey === 'string' ? r.messageKey : '';
  const mk = (phase: AgentEvent['phase'], extra: Partial<AgentEvent>): AgentEvent => ({
    id,
    ts,
    sessionId,
    adapter: 'workbuddy',
    phase,
    title: '',
    ...extra,
  });

  // 命令沙箱执行 → Bash 工具节点
  if (eventType.startsWith('command-safety.')) {
    const command = typeof params.command === 'string' ? params.command : undefined;
    return mk('tool_end', {
      tool: 'Bash',
      title: command ? `沙箱执行 ${cut(command, 40)}` : '沙箱执行命令',
      input: command ? { command } : undefined,
      status,
    });
  }

  // 文件安全（读取放行/审批/批量删除）→ 文件工具节点
  if (eventType.startsWith('file-safety.')) {
    const paths = splitPaths(params.paths).concat(splitPaths(params.targets));
    if (messageKey.includes('needsApproval')) {
      return mk('note', { title: `等待授权：${titleOf(fileToolOf(messageKey), paths)}` });
    }
    const tool = fileToolOf(messageKey);
    return mk('tool_end', {
      tool,
      title: titleOf(tool, paths),
      files: paths.length > 0 ? paths : undefined,
      status,
    });
  }

  // 敏感信息保护 → 说明节点（内容本身已脱敏，如实展示）
  if (eventType.startsWith('sensitive-protection.')) {
    if (eventType.endsWith('detected')) return mk('note', { title: '检测到敏感信息（内容已脱敏）' });
    if (eventType.endsWith('approval-resolved')) {
      return mk('note', { title: `敏感信息处理：${typeof params.choice === 'string' ? params.choice : '已决策'}` });
    }
    return mk('note', { title: '敏感信息：复用已授权原文' });
  }

  return null; // 未知类型不造节点
}

export interface ChangeFile {
  filePath: string;
  action: string;
  additions?: number;
  deletions?: number;
}

interface WorkbuddyChange {
  id?: unknown;
  conversationId?: unknown;
  createdAt?: unknown;
  summary?: unknown;
  additions?: unknown;
  deletions?: unknown;
  files?: unknown;
}

/** changes-index 条目 → 工具事件（create→Write / modify→Edit / delete→Bash）。 */
export function mapChangeEntry(change: WorkbuddyChange, now = Date.now()): AgentEvent | null {
  if (!change || typeof change !== 'object') return null;
  const sessionId = typeof change.conversationId === 'string' && change.conversationId ? change.conversationId : null;
  const changeId = typeof change.id === 'string' && change.id ? change.id : null;
  if (!sessionId || !changeId) return null;
  const rawFiles = Array.isArray(change.files) ? change.files : [];
  const files = rawFiles.filter(
    (f): f is ChangeFile => !!f && typeof f === 'object' && typeof (f as ChangeFile).filePath === 'string',
  );
  if (files.length === 0) return null;

  const creates = files.filter((f) => f.action === 'create');
  const deletes = files.filter((f) => f.action === 'delete');
  // 全部新建 → Write；全部删除 → Bash；混合（新建+修改/删除）按修改处理，标题带增删统计
  const tool = creates.length === files.length ? 'Write' : deletes.length === files.length ? 'Bash' : 'Edit';
  const verb = tool === 'Write' ? '写入' : tool === 'Bash' ? '删除' : '修改';
  const stat = `（+${typeof change.additions === 'number' ? change.additions : 0} −${typeof change.deletions === 'number' ? change.deletions : 0}）`;
  const title =
    files.length === 1 ? `${verb} ${cut(basename(files[0]!.filePath), 60)}` : `${verb} ${files.length} 个文件${stat}`;
  const ts = typeof change.createdAt === 'number' && Number.isFinite(change.createdAt) ? change.createdAt : now;
  return {
    id: `wb:chg:${changeId}`,
    ts,
    sessionId,
    adapter: 'workbuddy',
    phase: 'tool_end',
    tool,
    title,
    files: files.map((f) => f.filePath),
    input: {
      summary: typeof change.summary === 'string' ? change.summary : undefined,
      files: files.map((f) => ({ path: f.filePath, action: f.action, additions: f.additions ?? 0, deletions: f.deletions ?? 0 })),
    },
    status: 'ok',
  };
}

/** changes-index 整文件 → 事件数组（顺序保持 createdAt 升序） */
export function mapChangesDoc(doc: unknown, now = Date.now()): AgentEvent[] {
  if (!doc || typeof doc !== 'object') return [];
  const changes = (doc as { changes?: unknown }).changes;
  if (!Array.isArray(changes)) return [];
  return changes
    .map((c) => mapChangeEntry(c, now))
    .filter((e): e is AgentEvent => e !== null)
    .sort((a, b) => a.ts - b.ts);
}

export interface SidebarItem {
  sessionId: string;
  title: string;
  state: string;
  updatedAt: number;
}

/** sidebar-list-snapshot → 会话元数据（标题/状态），供 watcher 生成 user_prompt 与收尾事件 */
export function readSidebarItems(doc: unknown): SidebarItem[] {
  if (!doc || typeof doc !== 'object') return [];
  const items = (doc as { items?: unknown }).items;
  if (!Array.isArray(items)) return [];
  const out: SidebarItem[] = [];
  for (const it of items) {
    if (!it || typeof it !== 'object') continue;
    const o = it as Record<string, unknown>;
    if (typeof o.id !== 'string' || !o.id) continue;
    out.push({
      sessionId: o.id,
      title: typeof o.title === 'string' && o.title ? o.title : o.id,
      state: typeof o.state === 'string' ? o.state : '',
      updatedAt: typeof o.updatedAt === 'number' ? o.updatedAt : 0,
    });
  }
  return out;
}
