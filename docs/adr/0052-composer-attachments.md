# ADR-0052 输入框附件：粘贴截图与文件

- 状态：已接受
- 日期：2026-11-28
- 相关决策：ADR-0037（`@` 引用）、ADR-0005（事件日志为准）、ADR-0014（宽松许可依赖）
- 实现：`apps/desktop/src/main/services/attachment-service.ts`、`attachment-text.ts`；
  `apps/desktop/src/renderer/composer-attachments.ts`、`ComposerAttachments.tsx`

## 背景

ADR-0037 的 `@` 引用覆盖了有磁盘路径的文件：Finder / 资源管理器里复制、从文件树拖拽的文件，
进输入框时解析成磁盘路径再转成 `@路径` 引用。但剪贴板里的**截图**、从浏览器拖出的图片、
其它应用复制的文档只有内容、没有路径，此前粘贴进输入框直接没有反应。用户要求：

1. 粘贴截图要能在输入框里显示，并作为图片让模型看到；
2. 不限于图片，`.xlsx`、`.pdf` 等文档也要能粘贴进输入框，内容对模型可见。

## 决定

- **粘贴 / 拖入按有没有磁盘路径分流。** 有路径的仍走 ADR-0037 的 `@` 引用（保持既有行为）；
  只有内容、没有路径的文件（截图、浏览器图片、复制的文档）作为**附件**处理。
- **输入框里显示为附件条。** 附件渲染在文字框上方：截图显示缩略图，文件显示「名称 + 大小」的
  卡片，每项可单独删除。上限 `MAX_PROMPT_ATTACHMENTS = 5`（截图与文件合计），图片不超过
  `MAX_IMAGE_BYTES = 10 MB`，其它文件不超过 `MAX_FILE_BYTES = 20 MB`（界面提前提示，
  主进程保存时再检查一次）。有文字或附件即可发送，附件可以和文字混用。
- **发送前先交给主进程保存。** 渲染进程用 FileReader 读成 base64，经 `attachment.save` 写入
  内容寻址的 blob 存储（SHA-256，相同内容只存一份）。**图片类型按文件头识别**
  （PNG / JPEG / GIF / WebP），不信任剪贴板声明的 MIME；不是图片时按文件处理，
  MIME 只作为文字抽取的提示。
- **消息内容改成片段数组。** `session.prompt` / `session.editMessage` 的 `content` 从单个字符串
  变为 `ContentPart[]`（文字 / 图片 / 文件）。图片片段是 `{ blobRef, mimeType, data? }`，
  文件片段是 `{ blobRef, name, mimeType, size }`。
- **图片作为图片给模型。** 图片片段的 `data` 只在主进程 → 宿主的传输里填充：发送、引导与
  宿主重建历史前，主进程从 blob 存储读内容转 base64 填入。`data` 不落库、不进视图；事件日志
  里只有 `blobRef`。读不到 blob 时保持引用，由 pi 运行时转成占位文字，不让整条消息失败。
- **文档抽取成文字放上下文。** pi 运行时只接受文字与图片，不接受文档块。主进程在发送时把文件
  附件的文字抽出来（PDF 用 unpdf / pdf.js 取前 50 页；XLSX/XLSM 用已有的 fflate 解 OOXML 读
  sharedStrings 与单元格；DOCX / PPTX 取 XML 里的文字；文本类直接解码），拼成
  `<attachment name type size>` 块附在 `message.user.context`——与 ADR-0037 的引用展开
  同一快照语义，只给模型看、随消息落库。单个文件最多 32 KB，一条消息的附件文字总量最多
  96 KB；解析失败时附一句「内容无法抽取」，不阻断发送。文件片段本身不进模型的 `content`，
  运行时转成 `[attached file: 名称]` 占位。
- **草稿只存引用。** 草稿持久化只保存 `blobRef` 与元信息，不含 base64；缩略图按需经
  `attachment.read` 读取，渲染进程内带缓存。编辑重发与重新生成从事件读回内容后同样按
  `blobRef` 填回。

## 备选方案

- **一律转 `@` 引用**：截图没有磁盘路径，必须先把剪贴板内容落盘为文件，用户还得多一步
  管理临时文件。不选。
- **图片 base64 直接落库**：事件日志与会话数据库随图片体积膨胀，诊断包与导出都被拖大；
  宿主重启需要重建的内容反而更多。不选。
- **文档作为独立块交给运行时**：pi 的用户内容只有文字与图片，没有文档块；要支持必须改运行时
  与各家模型适配层，收益低。抽文字放 `context` 与 `@` 引用一致，模型读到的就是内容。
- **PDF 用 pdfjs-dist**：约 37 MB；unpdf（MIT，约 3 MB）内置 pdf.js 并提供 `getDocumentProxy`，
  满足取文字需求。选 unpdf。XLSX / DOCX / PPTX 用已有的 fflate 解压，不新增解析依赖。
- **附件随消息删除做垃圾回收**：本轮不做。内容寻址存储本来就允许多消息共享一个 blob，
  何时回收另行决定。

## 后果

- 用户删除输入框里的附件后，blob 仍留在存储里（内容寻址、可能被其它消息引用）；没有引用追踪，
  磁盘占用只增不减，直到未来引入 GC。
- 文档内容是发送那一刻的快照；之后文件在磁盘上变化，模型要自己重新读（与 ADR-0037 相同）。
- 大小与个数上限写进 `packages/protocol/src/limits.ts`，渲染进程与主进程共用。
- 新增依赖 `unpdf`（MIT，传递依赖 pdfjs，Apache-2.0），须通过 license 检查；unpdf 在主进程
  外部化，打包产物须验证运行时能解析。
- 宿主、压缩与 Goal 面板的文字化路径需要识别 `file` 片段（显示为 `[附件：名称]`），
  已在 `transcript.ts` / `compaction.ts` / `goal.ts` 同步处理。
