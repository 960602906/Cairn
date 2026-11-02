# ADR-0017 统一能力层：Tools、Skills 与 MCP

- 状态：已接受
- 日期：2026-11-02
- 详细设计：[Agent Runtime 详细设计第 21 节](../design/agent-runtime.md#21-能力层toolsskills-与-mcp)

## 背景

参考《NEXORA OS 架构设计草案》后发现，原设计只有"工具"一种能力，缺少 Skills（任务知识与流程），MCP 也只是计划中的一项功能。三者如果各自接入 agent 循环，会出现三套权限、三套事件和三种调用方式。

## 决定

- Agent 的能力分为三类：Tool（可执行操作）、Skill（如何完成某类任务的知识与流程）、MCP（接入外部能力的协议）。
- **模型只看到工具**：MCP 服务的工具适配为 `ToolDefinition` 注册进统一的工具注册表；Skill 通过内置工具 `load_skill` 按需加载，附带的脚本通过 `run_command` 执行。所有调用都经过同一条工具流水线。
- `ToolDefinition` 增加 `source`（builtin / mcp / skill）和 `trust`（builtin / user-configured / third-party），权限引擎据此设定默认值：MCP 工具默认需要审批。
- Skills 兼容社区通用的 `SKILL.md` 文件夹格式，上下文中只放索引，完整内容按需加载。
- Agent 定义增加 `skills` 字段。

## 备选方案

- **Skill 全部常驻上下文**：实现简单，但安装多个 Skill 后会挤占上下文，本地模型尤其明显。
- **MCP 工具单独走一套调用路径**：会绕开权限引擎和事件记录。

## 后果

- 新增能力来源时只需实现到 `ToolDefinition` 的适配。
- 管理界面需要提供 Skills 和 MCP 的管理入口。
- Skill 与项目文件一样视为不可信输入。
