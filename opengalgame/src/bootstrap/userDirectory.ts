import { isAbsolute, resolve, win32 } from 'node:path'

import { AppException } from '@common/errors/AppException'
import { ErrorCodes } from '@common/errors/ErrorCodes'

/**
 * 校验用户目录。首尾空白、NUL、非绝对路径，以及 Windows 下以空格或点结尾的路径段都拒绝，不静默 trim。
 * 合法路径返回去掉尾部分隔符的绝对路径。
 * @returns 规范化后的绝对路径。
 * @throws {AppException} 配置无效。
 */
export function assertUserDirectory(raw: string): string {
  if (raw !== raw.trim() || raw.includes('\u0000') || !isAbsolute(raw)) {
    throw new AppException({ code: ErrorCodes.invalidConfig, msg: '用户目录无效' })
  }
  const directory = resolve(raw)
  if (
    process.platform === 'win32' &&
    win32
      .normalize(directory)
      .split(/[\\/]/)
      .some((segment) => /[ .]$/.test(segment))
  ) {
    throw new AppException({ code: ErrorCodes.invalidConfig, msg: '用户目录无效' })
  }
  return directory
}
