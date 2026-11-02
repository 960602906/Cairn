/**
 * agent 宿主入口（ADR-0003，架构 §4）：由主进程通过 `utilityProcess.fork` 启动。
 *
 * M0-12a 只提供入口与构建；握手、运行时与工具执行在 M0-14 实现。
 * 当前启动后向主进程报告一次 `host.started`，供冒烟测试确认入口可以运行。
 */
import type {} from 'electron'

process.parentPort.postMessage({ type: 'host.started', pid: process.pid })
