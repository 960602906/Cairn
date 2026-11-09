/**
 * 第三方许可声明（M5-07）：读取随包的 `THIRD_PARTY_NOTICES.txt` 交给关于页。
 *
 * - 只返回声明正文，不返回文件路径或用户目录。
 * - 文件不存在或读取失败时 `available: false`，由界面提示，不抛错。
 * - 超大文件截断到上限并置 `truncated`；截断点不拆开代理对。
 */
import { readFileSync } from 'node:fs'

/** 返回给界面的最大字符数；正常声明约 0.9 MB，留出余量。 */
export const LICENSE_NOTICES_MAX_CHARS = 2_000_000

export interface LicenseNotices {
  /** 构建产物里是否存在声明文件且读取成功。 */
  readonly available: boolean
  readonly text: string
  readonly truncated: boolean
}

const UNAVAILABLE: LicenseNotices = { available: false, text: '', truncated: false }

export function readLicenseNotices(
  file: string,
  maxChars: number = LICENSE_NOTICES_MAX_CHARS,
): LicenseNotices {
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    return UNAVAILABLE
  }
  const limit = Math.max(0, Math.floor(maxChars))
  if (text.length <= limit) return { available: true, text, truncated: false }
  // 不把 UTF-16 代理对截成两半，避免界面出现替换字符。
  const last = limit > 0 ? text.charCodeAt(limit - 1) : 0
  const end = last >= 0xd800 && last <= 0xdbff ? limit - 1 : limit
  return { available: true, text: text.slice(0, end), truncated: true }
}
