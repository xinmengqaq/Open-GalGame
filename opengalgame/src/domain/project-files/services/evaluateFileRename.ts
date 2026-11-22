import { AppException } from '@common/errors/AppException'
import { ProjectFileErrorCodes } from '../errors/ProjectFileErrorCodes'
import type { FileRenameDecision } from '../models/FileRenameDecision'
import { requireSingleFileName, sameFileName, splitFileName } from './fileNameFacts'

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
