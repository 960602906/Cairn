/**
 * preload 暴露给界面的本地路径解析（Electron `webUtils.getPathForFile` 的窄封装）。
 *
 * Electron 45 起 `File.path` 已移除，改由 `webUtils.getPathForFile` 拿磁盘路径；渲染进程受
 * `contextIsolation` 与 `sandbox` 限制，无法直接导入 Electron，因此 preload 只把这一小段桥出来。
 */
export interface FilePathsApi {
  /**
   * 文件对象（渲染进程里的 `File`）对应的磁盘绝对路径；
   * 不是磁盘文件（如剪贴板里的合成对象）时返回空字符串。
   *
   * 参数用 `unknown` 是因为协议包不引入 DOM 类型；调用方传 `File` 即可。
   */
  readonly fromFile: (file: unknown) => string
}
