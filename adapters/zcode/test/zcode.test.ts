import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { ZCODE_HOOK_EVENTS, installZcode, uninstallZcode, hookScriptPath } from '../src/index.js';

const requireCjs = createRequire(import.meta.url);
const hook = requireCjs('../hook.cjs') as {
  mapPayload: (event: string, payload: Record<string, unknown>, now?: number) => Record<string, unknown> | null;
};

describe('mapPayload 事件映射', () => {
  it('UserPromptSubmit → user_prompt，标题截断', () => {
    const ev = hook.mapPayload('UserPromptSubmit', { session_id: 's1', prompt: 'x'.repeat(100) }, 1000);
    expect(ev!.phase).toBe('user_prompt');
    expect(ev!.title).toBe('用户：' + 'x'.repeat(60) + '…');
    expect(ev!.sessionId).toBe('s1');
  });

  it('PreToolUse Read → tool_start，提取 files', () => {
    const ev = hook.mapPayload(
      'PreToolUse',
      { session_id: 's1', tool_name: 'Read', tool_input: { file_path: 'src/a.ts' } },
      1000
    );
    expect(ev!.phase).toBe('tool_start');
    expect(ev!.tool).toBe('Read');
    expect(ev!.title).toBe('读取 src/a.ts');
    expect(ev!.files).toEqual(['src/a.ts']);
  });

  it('Bash → 不产出 files', () => {
    const ev = hook.mapPayload('PreToolUse', { session_id: 's1', tool_name: 'Bash', tool_input: { command: 'npm test' } }, 1000);
    expect(ev!.files).toBeUndefined();
    expect(ev!.title).toBe('执行 npm test');
  });

  it('PostToolUse → ok；PostToolUseFailure → error', () => {
    const ok = hook.mapPayload('PostToolUse', { session_id: 's1', tool_name: 'Edit', tool_input: { file_path: 'a' }, tool_response: { applied: true } }, 1000);
    expect(ok!.status).toBe('ok');
    const bad = hook.mapPayload('PostToolUseFailure', { session_id: 's1', tool_name: 'Edit', tool_input: { file_path: 'a' } }, 1000);
    expect(bad!.status).toBe('error');
  });

  it('SessionStart / Stop / PermissionRequest', () => {
    expect(hook.mapPayload('SessionStart', { session_id: 's1' }, 1)!.phase).toBe('note');
    expect(hook.mapPayload('Stop', { session_id: 's1' }, 1)!.phase).toBe('turn_end');
    expect(hook.mapPayload('PermissionRequest', { session_id: 's1', tool_name: 'Bash' }, 1)!.title).toBe('等待授权：Bash');
  });

  it('未知事件 → null', () => {
    expect(hook.mapPayload('Whatever', { session_id: 's1' }, 1)).toBeNull();
  });
});

describe('hook.cjs 端到端（stdin → POST → exit 0 无 stdout）', () => {
  it('真实进程跑一遍，事件到达桩服务器', async () => {
    const received: { events: Array<Record<string, unknown>> }[] = [];
    const srv = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        received.push(JSON.parse(body));
        res.statusCode = 202;
        res.end(JSON.stringify({ accepted: 1, rejected: 0 }));
      });
    });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    const port = (srv.address() as { port: number }).port;

    const res = spawnSync(process.execPath, [hookScriptPath(), 'PreToolUse'], {
      input: JSON.stringify({ session_id: 's-hook', tool_name: 'Read', tool_input: { file_path: 'a.ts' } }),
      env: { ...process.env, AGENT_FLOW_PORT: String(port) },
      encoding: 'utf8',
      timeout: 8000,
    });
    expect(res.status).toBe(0);
    expect(res.stdout).toBe('');
    await new Promise((r) => setTimeout(r, 100));
    expect(received).toHaveLength(1);
    expect(received[0]!.events[0]!.phase).toBe('tool_start');
    srv.close();
  }, 15000);

  it('server 不在线：静默 exit 0', () => {
    const res = spawnSync(process.execPath, [hookScriptPath(), 'Stop'], {
      input: JSON.stringify({ session_id: 'x' }),
      env: { ...process.env, AGENT_FLOW_PORT: '59999' },
      encoding: 'utf8',
      timeout: 8000,
    });
    expect(res.status).toBe(0);
    expect(res.stdout).toBe('');
  }, 15000);
});

describe('installZcode / uninstallZcode', () => {
  const mkHome = () => mkdtempSync(join(tmpdir(), 'af-zcode-'));

  it('安装：七个事件注入 process 型 hook，enabled=true', () => {
    const home = mkHome();
    const { configPath } = installZcode({ homeDir: home });
    const cfg = JSON.parse(readFileSync(configPath, 'utf8'));
    expect(cfg.hooks.enabled).toBe(true);
    expect(Object.keys(cfg.hooks.events).sort()).toEqual([...ZCODE_HOOK_EVENTS].sort());
    for (const ev of ZCODE_HOOK_EVENTS) {
      const entry = cfg.hooks.events[ev][0];
      expect(entry.type).toBe('process');
      expect(entry.command).toBe(process.execPath);
      expect(entry.args[1]).toBe(ev);
      expect(entry.args[0]).toBe(hookScriptPath());
      expect(entry.timeoutMs).toBeLessThanOrEqual(900);
    }
  });

  it('幂等：装两遍无重复条目；已有用户 hook 共存', () => {
    const home = mkHome();
    const configPath = join(home, '.zcode', 'cli', 'config.json');
    mkdirSync(join(home, '.zcode', 'cli'), { recursive: true });
    writeFileSync(
      configPath,
      JSON.stringify({
        model: 'keep-me',
        hooks: { events: { PostToolUse: [{ type: 'command', command: 'echo hi' }] } },
      })
    );
    installZcode({ homeDir: home });
    installZcode({ homeDir: home });
    const cfg = JSON.parse(readFileSync(configPath, 'utf8'));
    expect(cfg.model).toBe('keep-me');
    expect(cfg.hooks.events.PostToolUse).toHaveLength(2); // 用户的 + 我们的
    const ourCount = cfg.hooks.events.PreToolUse.filter(
      (e: { args: string[] }) => e.args?.[0] === hookScriptPath()
    ).length;
    expect(ourCount).toBe(1);
  });

  it('卸载：只删我们的条目，用户 hook 保留', () => {
    const home = mkHome();
    installZcode({ homeDir: home });
    const configPath = join(home, '.zcode', 'cli', 'config.json');
    const cfg = JSON.parse(readFileSync(configPath, 'utf8'));
    cfg.hooks.events.PostToolUse.push({ type: 'command', command: 'echo user' });
    writeFileSync(configPath, JSON.stringify(cfg));
    uninstallZcode({ homeDir: home });
    const after = JSON.parse(readFileSync(configPath, 'utf8'));
    expect(after.hooks.events.PostToolUse).toEqual([{ type: 'command', command: 'echo user' }]);
    expect(after.hooks.events.PreToolUse).toBeUndefined();
  });
});
