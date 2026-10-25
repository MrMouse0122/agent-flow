import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * DeepSeek Harness（dsh）适配器 —— telemetry 插件式接入（官方姿势）。
 *
 * 真正的映射与订阅逻辑在 plugin/ 下（纯 ESM JS，dsh 的 Cordis 插件体系直接加载，
 * 不经本 monorepo 的 TS 构建）：
 *   - plugin/mapper.js  会话事件 → AgentEvent 纯映射（test/dsh.test.ts 覆盖）
 *   - plugin/index.js   Cordis 插件：ctx.on('session/event') → 批量 POST server
 *   - cordis.patch.yml  --patch 挂载用补丁
 * 本入口只为 CLI 提供路径解析，不承载逻辑。
 */

/** 插件目录绝对路径（CLI 安装提示用） */
export function pluginDir(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '../../plugin');
}

/** cordis.patch.yml 绝对路径（--patch 挂载用） */
export function patchFile(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '../../cordis.patch.yml');
}

export const dsHarnessStatus = 'plugin-ready' as const;
export const dsHarnessPluginDir = pluginDir;
export const dsHarnessPatchFile = patchFile;
export const dsHarnessCli = join('dsh');
