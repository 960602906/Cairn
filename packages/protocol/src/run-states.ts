/**
 * 运行状态的取值（Runtime §5.1）。单独成文件：界面与状态机只需要这份列表，
 * 不该为了它把 zod 与 schema 带进首屏；schema 在 `common.ts` 里由它构造。
 */
export const RUN_STATES = [
  'idle',
  'thinking',
  'tooling',
  'awaiting_approval',
  'awaiting_children',
  'completed',
  'aborting',
  'failed',
  'interrupted',
  'disposed',
] as const
