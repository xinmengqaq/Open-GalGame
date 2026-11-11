import { AppException } from '@common/errors/AppException'
import { ProjectFileErrorCodes } from '../errors/ProjectFileErrorCodes'
import type { FileRenameDecision } from '../models/FileRenameDecision'
import { requireSingleFileName, sameFileName, splitFileName } from './fileNameFacts'

/**
 * 判断新名称是否满足重命名规则。
 * 占用名称不包含当前文件自身。名称未变化时不产生提交。冲突时失败，不自动覆盖。
 * @param newFileName - 用户给出的新文件名，不含目录。
 * @throws {AppException} 文件名无效、扩展名改变或目标名称已被占用。
 */
export function evaluateFileRename(
  currentFileName: string,
  newFileName: string,
  occupiedNames: readonly string[]
): FileRenameDecision {
  requireSingleFileName(currentFileName)
  requireSingleFileName(newFileName)
  if (sameFileName(currentFileName, newFileName)) return { changed: false }
  const currentExtension = splitFileName(currentFileName).extension
  const nextExtension = splitFileName(newFileName).extension
  if (
    currentExtension === null ||
    nextExtension === null ||
    currentExtension.toLowerCase() !== nextExtension.toLowerCase()
  ) {
    throw new AppException({
      code: ProjectFileErrorCodes.fileExtensionChanged,
      msg: '重命名必须保留原扩展名'
    })
  }
  if (occupiedNames.some((name) => sameFileName(name, newFileName))) {
    throw new AppException({
      code: ProjectFileErrorCodes.fileNameConflict,
      msg: '该文件名已被占用'
    })
  }
  return { changed: true, fileName: newFileName }
}
