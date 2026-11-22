import { isAbsolute, resolve, win32 } from 'node:path'

import { AppException } from '@common/errors/AppException'
import { ErrorCodes } from '@common/errors/ErrorCodes'

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
