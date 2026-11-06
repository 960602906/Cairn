/** 路径最后一段，兼容 Windows 分隔符（项目名的后备显示，M2-02）。 */
export const lastSegment = (path: string): string =>
  path
    .split(/[\\/]+/)
    .filter(Boolean)
    .at(-1) ?? path
