/**
 * 界面与 schema 共用的长度上限与固定 id。
 *
 * 从 schema 文件里拆出来，是为了让渲染进程能单独引用这些常量而不连带加载 zod 与全部 schema
 * （见 `runtime.ts`）。schema 文件从这里取值，再按原路径重新导出，保持既有导入不变。
 */

/** 项目名称的长度上限（字符，M3-02）。 */
export const PROJECT_NAME_MAX_LENGTH = 200

/** 首次启动时自动创建、不可移除的默认项目（稳定 id）。 */
export const DEFAULT_PROJECT_ID = 'default-project'

/** 默认项目的兜底名称；界面按当前语言显示本地化名称。 */
export const DEFAULT_PROJECT_NAME = 'Default Project'

/** 会话标题的长度上限（字符，M2-02）。 */
export const SESSION_TITLE_MAX_LENGTH = 200

/** 自定义说明的长度上限（字符）。 */
export const INSTRUCTIONS_MAX_LENGTH = 10_000

/** 计划模式里一次反馈的长度上限。 */
export const PLAN_FEEDBACK_MAX = 4_000

/** 一条输入最多带几个 `@` 引用（ADR-0037）。 */
export const MAX_PROMPT_MENTIONS = 20

/** 一条输入最多使用几个技能。 */
export const MAX_PROMPT_SKILLS = 5

/** 一条输入最多点名几个要委派的 Agent。 */
export const MAX_PROMPT_AGENTS = 5

/** 一条输入最多带几个粘贴的附件（截图与文件合计）。 */
export const MAX_PROMPT_ATTACHMENTS = 5

/** 一张粘贴图片的大小上限（字节）；主进程保存时检查，界面提前提示。 */
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024

/** 一个粘贴文件的大小上限（字节）；超过时拒绝，避免把大文件读进内存再编码。 */
export const MAX_FILE_BYTES = 20 * 1024 * 1024

/** 一次批量检查多少个路径是否存在（助手消息里的行内代码）。 */
export const MAX_EXISTS_PATHS = 200

/** 一次审批意见的长度上限。 */
export const APPROVAL_FEEDBACK_MAX_LENGTH = 2_000

/** Agent 指令的长度上限：超过会挤占上下文，保存时报错。 */
export const AGENT_INSTRUCTIONS_MAX_CHARS = 64_000
