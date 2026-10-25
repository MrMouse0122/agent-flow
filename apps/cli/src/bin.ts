import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { demoSession, type AgentEvent } from '@agent-flow/protocol';
import { startServer } from '@agent-flow/server';
import { installZcode, uninstallZcode } from '@agent-flow/adapter-zcode';
import { startCodexWatcher } from '@agent-flow/adapter-codex';
import { startGenericWatcher } from '@agent-flow/adapter-generic';

const PORT = Number(process.env.AGENT_FLOW_PORT ?? 4765);
const URL = `http://127.0.0.1:${PORT}`;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function openBrowser(url: string): void {
  try {
    if (process.platform === 'win32') {
      spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref();
    } else if (process.platform === 'darwin') {
      spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
    } else {
      spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
    }
  } catch {
    // 打不开就手动访问
  }
}

async function serverOnline(): Promise<boolean> {
  try {
    const res = await fetch(`${URL}/api/health`, { signal: AbortSignal.timeout(600) });
    return res.ok;
  } catch {
    return false;
  }
}

async function postEvent(ev: AgentEvent): Promise<void> {
  await fetch(`${URL}/api/events`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ events: [ev] }),
    signal: AbortSignal.timeout(3000),
  });
}

async function cmdStart(args: string[]): Promise<void> {
  const noOpen = args.includes('--no-open');
  const watchDirs: string[] = [];
  args.forEach((a, i) => {
    if (a === '--watch' && args[i + 1]) watchDirs.push(args[i + 1]!);
  });

  await startServer({});

  const codexDir = join(homedir(), '.codex', 'sessions');
  if (existsSync(codexDir)) {
    startCodexWatcher({ sessionsDir: codexDir });
    console.log(`已启动 Codex 会话监视：${codexDir}`);
  }
  for (const dir of watchDirs) {
    startGenericWatcher({ dir });
    console.log(`已启动通用日志监视：${dir}`);
  }

  if (!noOpen) openBrowser(URL);
  console.log(`AgentFlow 运行中 — ${URL}（Ctrl+C 退出）`);
  console.log('提示：ZCode 接入需要先执行一次 `npm run start -w apps/cli -- install`');
}

async function cmdDemo(args: string[]): Promise<void> {
  const speed = Number(args.find((a) => a.startsWith('--speed='))?.slice(8) || 4);
  const keepServer = !(await serverOnline());
  if (keepServer) {
    await startServer({});
    console.log('AgentFlow server 未运行，已自动启动');
    openBrowser(URL);
  }

  // 每次演示生成新 sessionId，避免与历史演示事件 id 撞车被去重
  const sessionId = `demo-${Date.now().toString(36)}`;
  const events = demoSession.map((ev) => ({
    ...ev,
    sessionId,
    id: ev.id.replace('demo-1', sessionId),
  }));

  console.log(`开始推送演示会话 ${sessionId}（${events.length} 个事件，${speed}x 速度）…`);
  let prevTs = events[0]!.ts;
  for (const ev of events) {
    const gap = ev.ts - prevTs;
    prevTs = ev.ts;
    if (gap > 0) await sleep(gap / speed);
    await postEvent({ ...ev, ts: Date.now() });
    process.stdout.write('.');
  }
  console.log('\n演示会话推送完成。打开面板观看：' + URL);
  if (!keepServer) process.exit(0);
  console.log('（server 随本命令常驻，Ctrl+C 退出）');
}

async function cmdInstall(): Promise<void> {
  const { configPath } = installZcode({});
  console.log(`已注册 ZCode hooks → ${configPath}`);
  console.log('ZCode 里的每一次操作现在都会实时出现在 AgentFlow 面板上。');
  console.log('Codex 接入（可选）：在 ~/.codex/config.toml 加一行');
  console.log(`  notify = ["node", "${join(import.meta.dirname, '../../../adapters/codex/notify.cjs')}"]`);
  console.log('并保持 `agent-flow start` 运行以监视 ~/.codex/sessions。');
}

async function cmdUninstall(): Promise<void> {
  uninstallZcode({});
  console.log('已移除 AgentFlow 的 ZCode hooks（你自己的 hooks 未动）。');
}

/** 把「实时上报」skill 装进 ~/.zcode/skills/，让 ZCode 会话自己叙述每一步 */
async function cmdSkill(args: string[]): Promise<void> {
  const src = join(import.meta.dirname, '../../../adapters/skill/SKILL.md');
  const destDir = join(homedir(), '.zcode', 'skills', 'agent-flow');
  if (args.includes('--remove')) {
    rmSync(destDir, { recursive: true, force: true });
    console.log(`已移除 AgentFlow skill（${destDir}）。`);
    return;
  }
  if (!existsSync(src)) throw new Error(`找不到 skill 源文件：${src}`);
  mkdirSync(destDir, { recursive: true });
  copyFileSync(src, join(destDir, 'SKILL.md'));
  console.log(`已安装 AgentFlow skill → ${destDir}`);
  console.log('之后新开的 ZCode 会话干活时，会自动把每一步「做了什么 / 为什么」上报到面板（server 不在线则自动跳过）。');
  console.log('卸载：npx tsx apps/cli/src/bin.ts skill --remove');
}

function cmdOpen(): void {
  openBrowser(URL);
}

async function main(): Promise<void> {
  const [cmd, ...args] = process.argv.slice(2);
  switch (cmd) {
    case 'start':
      await cmdStart(args);
      break;
    case 'demo':
      await cmdDemo(args);
      break;
    case 'install':
      await cmdInstall();
      break;
    case 'uninstall':
      await cmdUninstall();
      break;
    case 'skill':
      await cmdSkill(args);
      break;
    case 'open':
      cmdOpen();
      break;
    default:
      console.log(`AgentFlow — AI Agent 执行过程实时流程图

用法：
  agent-flow start [--no-open] [--watch <目录>]   启动守护进程（server + codex/generic 监视）并打开面板
  agent-flow demo [--speed=4]                     推送一段模拟会话，立即看到实时出图效果
  agent-flow install / uninstall                  注册 / 移除 ZCode hooks
  agent-flow skill [--remove]                     安装 / 移除「实时上报」skill（AI 自己叙述每一步）
  agent-flow open                                 打开面板
`);
      process.exit(cmd ? 1 : 0);
  }
}

main().catch((err) => {
  console.error('agent-flow 出错：', err);
  process.exit(1);
});
