import { basename } from 'node:path'

import { AppException } from '@common/errors/AppException'
import { ProjectFileErrorCodes } from '@domain/project-files/errors/ProjectFileErrorCodes'

const reserved = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/iu

/**
 * @returns 文件名；无法识别时为“所选文件”。
 */
export function fileNameFromPath(localFilePath: string): string {
  const name = basename(localFilePath)
  return name === '' || name === '.' || name === '..' ? '所选文件' : name
}

/**
 * 拒绝操作系统保留名和非法字符。领域规则已拒绝目录。
 * @throws {AppException} 名称不能落盘。
 */
export function assertPersistableFileName(fileName: string): void {
  if (
    reserved.test(fileName) ||
    /[<>:"|?*\u0000-\u001f]/u.test(fileName) ||
    fileName.endsWith(' ') ||
    fileName.endsWith('.')
  ) {
    throw new AppException({
      code: ProjectFileErrorCodes.invalidFileName,
      msg: '文件名无效'
    })
  }
}
