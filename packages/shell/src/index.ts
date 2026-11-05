/**
 * @nexus/shell —— Shell 适配器（ADR-0012，架构 §9.3）：选择 shell、把命令包装为进程调用并执行，
 * 结束整个进程树，清洗环境变量。业务代码不出现特定 shell 的语法。
 */
export * from './select.js'
export * from './powershell.js'
export * from './invocation.js'
export * from './env.js'
export * from './job-object.js'
export * from './process-tree.js'
export * from './run.js'
