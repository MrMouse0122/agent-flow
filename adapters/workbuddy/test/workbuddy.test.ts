import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AgentEvent } from '@agent-flow/protocol';
import { mapAuditRecord, mapChangesDoc, mapChangeEntry, readSidebarItems, startWorkbuddyWatcher } from '../src/index.js';

const waitFor = async (fn: () => boolean, timeoutMs = 8000): Promise<void> => {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timeout');
    await new Promise((r) => setTimeout(r, 100));
  }
};

describe('mapAuditRecord — 真实审计记录', () => {
  const base = {
    sessionId: '38270564-d102-400a-8912-b3f2846e8877',
    requestId: '01a1718021267e6eb98643a2926acba8',
    toolCallId: 'chatcmpl-tool-92df1324cb4bf0ba',
    id: 'a3625295-b02a-4289-a91e-eb6e7f7d96c3',
    timestamp: 1792905610586,
    source: 'spool',
    schemaVersion: 2,
    sequence: 790,
  };

  it('command-safety.sandbox-executed → Bash tool_end，命令进 input', () => {
    const ev = mapAuditRecord({
      ...base,
      category: 'command-safety',
      eventType: 'command-safety.sandbox-executed',
      decision: 'allowed',
      messageKey: 'securityCenter.audit.commandSafety.sandboxExecuted',
      messageParams: { command: 'npm run build 2>&1 | tail -40' },
    });
    expect(ev!.phase).toBe('tool_end');
    expect(ev!.tool).toBe('Bash');
    expect(ev!.title).toContain('沙箱执行');
    expect(ev!.title).toContain('npm run build');
    expect((ev!.input as { command: string }).command).toBe('npm run build 2>&1 | tail -40');
    expect(ev!.status).toBe('ok');
    expect(ev!.id).toBe('wb:aud:a3625295-b02a-4289-a91e-eb6e7f7d96c3');
    expect(ev!.ts).toBe(1792905610586);
  });

  it('file-safety.allow-listed（readWithRule）→ Read tool_end，paths 进 files', () => {
    const ev = mapAuditRecord({
      ...base,
      id: '67ab4c39-5b89-4db6-b5aa-0077172ceb5f',
      category: 'file-safety',
      eventType: 'file-safety.allow-listed',
      decision: 'allowed',
      messageKey: 'securityCenter.audit.fileSafety.allowListed.readWithRule',
      messageParams: { paths: 'C:/Users/Mr.Mouse/WorkBuddy/2026-10-18-20-17-14/绿水青山就是金山银山.txt' },
    });
    expect(ev!.phase).toBe('tool_end');
    expect(ev!.tool).toBe('Read');
    expect(ev!.title).toContain('绿水青山就是金山银山.txt');
    expect(ev!.files).toEqual(['C:/Users/Mr.Mouse/WorkBuddy/2026-10-18-20-17-14/绿水青山就是金山银山.txt']);
  });

  it('file-safety.needsApproval → note 等待授权；决策被拒 → status error', () => {
    const note = mapAuditRecord({
      ...base,
      id: 'x1',
      eventType: 'file-safety.needs-approval',
      decision: 'pending',
      messageKey: 'securityCenter.audit.fileSafety.needsApproval.read',
      messageParams: { paths: 'C:/secret' },
    });
    expect(note!.phase).toBe('note');
    expect(note!.title).toContain('等待授权');

    const denied = mapAuditRecord({
      ...base,
      id: 'x2',
      eventType: 'command-safety.sandbox-executed',
      decision: 'blocked',
      messageKey: 'securityCenter.audit.commandSafety.sandboxExecuted',
      messageParams: { command: 'rm -rf /' },
    });
    expect(denied!.status).toBe('error');
  });

  it('bulkDelete → Bash；sensitive-protection → note；manifest/config 行 → null', () => {
    const bulk = mapAuditRecord({
      ...base,
      id: 'x3',
      eventType: 'file-safety.bulk-delete.approved',
      decision: 'allowed',
      messageKey: 'securityCenter.audit.fileSafety.bulkDelete.approved',
      messageParams: { command: 'rm -rf out', targets: 'C:/a; C:/b' },
    });
    expect(bulk!.tool).toBe('Bash');
    expect(bulk!.files).toEqual(['C:/a', 'C:/b']);

    const sens = mapAuditRecord({ ...base, id: 'x4', eventType: 'sensitive-protection.detected', messageKey: 'k', messageParams: {} });
    expect(sens!.phase).toBe('note');
    expect(sens!.title).toContain('敏感');

    expect(mapAuditRecord({ event: 'segment-closed', segment: 'x.jsonl' })).toBeNull();
    expect(mapAuditRecord({ ...base, id: 'x5', eventType: 'config.orderedRules.migrated' })).toBeNull();
    expect(mapAuditRecord(null)).toBeNull();
  });
});

describe('mapChangesDoc — changes-index 整文件', () => {
  const doc = {
    version: 2,
    changes: [
      {
        id: '38270564-d102-400a-8912-b3f2846e8877,01a1694871497bd1af465a4151e0f6ac',
        conversationId: '38270564-d102-400a-8912-b3f2846e8877',
        requestId: '01a1694871497bd1af465a4151e0f6ac',
        summary: '8 个文件变更，+1177 −0',
        fileCount: 2,
        additions: 12,
        deletions: 1,
        createdAt: 1792767886747,
        files: [
          { filePath: 'C:/wb/probe.py', action: 'create', additions: 11, deletions: 0 },
          { filePath: 'C:/wb/wtest.txt', action: 'modify', additions: 1, deletions: 1 },
        ],
      },
      { id: 'conv2,req2', conversationId: 'conv2', createdAt: 1792767000000, files: [{ filePath: 'C:/x', action: 'delete' }] },
    ],
  };

  it('create→Write / 多文件混合→Edit / 纯删除→Bash，按 createdAt 排序', () => {
    const events = mapChangesDoc(doc);
    expect(events).toHaveLength(2);
    const [first, second] = events; // conv2 的 createdAt 更早，排前面
    expect(first!.sessionId).toBe('conv2');
    expect(first!.tool).toBe('Bash');
    expect(second!.sessionId).toBe('38270564-d102-400a-8912-b3f2846e8877');
    expect(second!.tool).toBe('Edit'); // create+modify 混合 → 修改
    expect(second!.title).toContain('修改 2 个文件');
    expect(second!.files).toEqual(['C:/wb/probe.py', 'C:/wb/wtest.txt']);
    expect(second!.ts).toBe(1792767886747);
    expect(second!.id).toBe('wb:chg:38270564-d102-400a-8912-b3f2846e8877,01a1694871497bd1af465a4151e0f6ac');
  });

  it('单个新建文件 → Write 带文件名', () => {
    const ev = mapChangeEntry({
      id: 'c,1',
      conversationId: 'c',
      createdAt: 5,
      files: [{ filePath: 'D:/proj/a.ts', action: 'create' }],
    });
    expect(ev!.tool).toBe('Write');
    expect(ev!.title).toContain('a.ts');
  });

  it('缺 sessionId / 缺 files 的条目 → null；非对象 → 空数组', () => {
    expect(mapChangeEntry({ id: 'x' })).toBeNull();
    expect(mapChangeEntry({ id: 'x', conversationId: 'c' })).toBeNull();
    expect(mapChangesDoc({ changes: 'nope' })).toEqual([]);
    expect(mapChangesDoc(null)).toEqual([]);
  });
});

describe('readSidebarItems', () => {
  it('提取 sessionId/title/state/updatedAt；坏条目跳过', () => {
    const items = readSidebarItems({
      version: 3,
      savedAt: 1,
      items: [
        { id: 's1', title: '排查mybatis找不到User类的错误', state: 'idle', updatedAt: 100 },
        { id: 's2', state: 'running', updatedAt: 200 }, // 无 title → 用 id
        { nope: true },
      ],
    });
    expect(items).toHaveLength(2);
    expect(items[0]).toEqual({ sessionId: 's1', title: '排查mybatis找不到User类的错误', state: 'idle', updatedAt: 100 });
    expect(items[1]!.title).toBe('s2');
  });
});

describe('watcher 端到端（临时目录）', () => {
  it('audit tail + changes 重写 + 标题快照 + 空闲收尾，全部幂等', async () => {
    const home = mkdtempSync(join(tmpdir(), 'af-wb-'));
    const sid = 'sess-1';
    mkdirSync(join(home, 'audit-log'), { recursive: true });
    mkdirSync(join(home, 'changes-index'), { recursive: true });
    mkdirSync(join(home, 'profile-1'), { recursive: true });

    const events: AgentEvent[] = [];
    const watcher = startWorkbuddyWatcher({ homeDir: home, onEvent: (ev) => events.push(ev) });

    // 1) 审计日志：先 1 行，再追加 1 行
    const audit = join(home, 'audit-log', '2026-10-25.jsonl');
    writeFileSync(
      audit,
      JSON.stringify({
        sessionId: sid, id: 'aud-1', timestamp: 1000, eventType: 'command-safety.sandbox-executed',
        decision: 'allowed', messageKey: 'securityCenter.audit.commandSafety.sandboxExecuted',
        messageParams: { command: 'npm test' },
      }) + '\n'
    );
    await waitFor(() => events.some((e) => e.id === 'wb:aud:aud-1'));

    // 2) 变更索引（整文件重写两次，第二次含新条目 + 旧条目）
    const changesFile = join(home, 'changes-index', `${sid}.json`);
    const change = {
      id: `${sid},req-1`, conversationId: sid, createdAt: 2000, summary: '1 个文件变更',
      files: [{ filePath: 'C:/wb/a.ts', action: 'create', additions: 5, deletions: 0 }],
    };
    writeFileSync(changesFile, JSON.stringify({ version: 2, changes: [change] }));
    await waitFor(() => events.some((e) => e.id === 'wb:chg:' + change.id));
    writeFileSync(changesFile, JSON.stringify({ version: 2, changes: [change, { ...change, id: `${sid},req-2`, createdAt: 3000, files: [{ filePath: 'C:/wb/b.ts', action: 'modify' }] }] }));
    await waitFor(() => events.some((e) => e.id === 'wb:chg:' + sid + ',req-2'));
    const countAfterChanges = events.length;

    // 3) 标题快照：running → 触发 user_prompt；转 idle → 触发 turn_end
    const snapshot = join(home, 'profile-1', 'sidebar-list-snapshot.json');
    writeFileSync(snapshot, JSON.stringify({ version: 3, items: [{ id: sid, title: '修登录页', state: 'running', updatedAt: 2500 }] }));
    await waitFor(() => events.some((e) => e.phase === 'user_prompt'));
    const prompt = events.find((e) => e.phase === 'user_prompt')!;
    expect(prompt.title).toBe('用户：修登录页');
    expect((prompt.input as { source: string }).source).toBe('workbuddy-session-title');
    expect(prompt.ts).toBeLessThanOrEqual(1000); // 排到时间线最前

    writeFileSync(snapshot, JSON.stringify({ version: 3, items: [{ id: sid, title: '修登录页', state: 'idle', updatedAt: 4000 }] }));
    await waitFor(() => events.some((e) => e.phase === 'turn_end'));

    // 4) 幂等：重写相同 changes 内容不再产生新事件
    writeFileSync(changesFile, JSON.stringify({ version: 2, changes: [change, { ...change, id: `${sid},req-2`, createdAt: 3000, files: [{ filePath: 'C:/wb/b.ts', action: 'modify' }] }] }));
    await new Promise((r) => setTimeout(r, 700));
    expect(events.length).toBeGreaterThan(countAfterChanges); // turn_end 已到
    const turnEndCount = events.filter((e) => e.phase === 'turn_end').length;
    const promptCount = events.filter((e) => e.phase === 'user_prompt').length;
    expect(events.filter((e) => e.id.startsWith('wb:chg:')).length).toBe(2);
    // 标题与收尾各只发一次
    writeFileSync(snapshot, JSON.stringify({ version: 3, items: [{ id: sid, title: '修登录页', state: 'idle', updatedAt: 4000 }] }));
    await new Promise((r) => setTimeout(r, 700));
    expect(events.filter((e) => e.phase === 'user_prompt')).toHaveLength(promptCount);
    expect(events.filter((e) => e.phase === 'turn_end')).toHaveLength(turnEndCount);

    await watcher.stop();
  }, 15000);
});
