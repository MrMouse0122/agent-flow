import type { AgentEvent } from '@agent-flow/protocol';

/** dsh 会话事件信封：{ seq, time, type, data }（字段在真实环境可能有别名，映射器已做兼容） */
export interface DshEventRecord {
  seq?: number;
  time?: number | string;
  type: string;
  data?: Record<string, unknown>;
}

/** 一条 dsh 会话事件 → AgentEvent；无法识别/信息不足的类型返回 null */
export declare function mapDshEvent(
  record: DshEventRecord | unknown,
  sessionId: string | undefined,
  now?: number,
): AgentEvent | null;
