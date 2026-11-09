/**
 * 应用身份（M5-01，ADR-0035）：安装包、快捷方式、任务栏与通知共用同一组标识。
 *
 * 开发版与安装版使用不同的 AppUserModelID，避免开发时的通知与任务栏图标混到安装版上。
 * `appId`、产品名与版权同时写在 `apps/desktop/package.json`，由 M5-02 的打包配置读取。
 */
export const APP_IDENTITY = Object.freeze({
  appId: 'com.cairn.desktop',
  productName: 'Cairn',
  copyright: 'Copyright © 2026 Cairn contributors',
})

/** Windows 的 AppUserModelID：安装版用应用标识，开发版加 `.dev` 后缀。 */
export function appUserModelId(packaged: boolean): string {
  return packaged ? APP_IDENTITY.appId : `${APP_IDENTITY.appId}.dev`
}
