import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** ZCode 支持的全部 hook 事件（正好七种） */
export const ZCODE_HOOK_EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'PermissionRequest',
  'Stop',
] as const;

export type ZcodeHookEvent = (typeof ZCODE_HOOK_EVENTS)[number];

export function hookScriptPath(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '../hook.cjs');
}

interface HookEntry {
  type?: string;
  command?: string;
  args?: unknown[];
  timeoutMs?: number;
}

const isOurEntry = (entry: HookEntry) =>
  entry.type === 'process' &&
  Array.isArray(entry.args) &&
  entry.args.some(
    (a) => typeof a === 'string' && a.replace(/\\/g, '/').endsWith('adapters/zcode/hook.cjs')
  );

function readConfig(configPath: string): Record<string, unknown> {
  if (!existsSync(configPath)) return {};
  try {
    return JSON.parse(readFileSync(configPath, 'utf8')) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export interface InstallResult {
  configPath: string;
  hookPath: string;
}

/**
 * 把 AgentFlow 的 hook 注册进 ~/.zcode/cli/config.json（或 workspace 配置）。
 * - 先备份原始配置（只备份一次）
 * - hooks.enabled = true（配置文件 hooks 默认关闭，必须显式打开）
 * - 七个事件各追加一条 process 型 hook（无 shell，Windows 最稳）
 * - 幂等：重复执行不产生重复条目；用户已有 hook 共存不丢
 */
export function installZcode(opts: { homeDir?: string } = {}): InstallResult {
  const configPath = join(opts.homeDir ?? homedir(), '.zcode', 'cli', 'config.json');
  mkdirSync(dirname(configPath), { recursive: true });
  if (existsSync(configPath)) {
    const backup = `${configPath}.agent-flow.bak`;
    if (!existsSync(backup)) copyFileSync(configPath, backup);
  }

  const config = readConfig(configPath) as {
    hooks?: { enabled?: boolean; events?: Record<string, HookEntry[]> };
  };
  config.hooks = config.hooks ?? {};
  config.hooks.enabled = true;
  config.hooks.events = config.hooks.events ?? {};

  const hookPath = hookScriptPath();
  for (const ev of ZCODE_HOOK_EVENTS) {
    const list = Array.isArray(config.hooks.events[ev]) ? config.hooks.events[ev]! : [];
    const already = list.some(isOurEntry);
    if (!already) {
      list.push({ type: 'process', command: process.execPath, args: [hookPath, ev], timeoutMs: 900 });
    }
    config.hooks.events[ev] = list;
  }

  writeFileSync(configPath, JSON.stringify(config, null, 2));
  return { configPath, hookPath };
}

/** 移除我们注入的全部 hook 条目；用户自己的 hook 原样保留。 */
export function uninstallZcode(opts: { homeDir?: string } = {}): void {
  const configPath = join(opts.homeDir ?? homedir(), '.zcode', 'cli', 'config.json');
  if (!existsSync(configPath)) return;
  const config = readConfig(configPath) as {
    hooks?: { enabled?: boolean; events?: Record<string, HookEntry[]> };
  };
  if (!config.hooks?.events) return;

  for (const ev of Object.keys(config.hooks.events)) {
    const list = config.hooks.events[ev] ?? [];
    const kept = list.filter((e) => !isOurEntry(e));
    if (kept.length > 0) config.hooks.events[ev] = kept;
    else delete config.hooks.events[ev];
  }
  if (Object.keys(config.hooks.events).length === 0) {
    delete config.hooks; // 只剩空壳时连 hooks 键一起删
  }
  writeFileSync(configPath, JSON.stringify(config, null, 2));
}
