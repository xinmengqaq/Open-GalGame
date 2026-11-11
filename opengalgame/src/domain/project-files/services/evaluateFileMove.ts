import { AppException } from '@common/errors/AppException'
import { ProjectFileErrorCodes } from '../errors/ProjectFileErrorCodes'
import { sameFileName } from './fileNameFacts'

export type FileMoveDecision = { changed: false } | { changed: true }

/**
 * 判断文件移动。原归属变化、目标同名时失败；目标即当前父目录时不提交。
 * @throws {AppException} 归属已变化或目标名称被占用。
 */
export function evaluateFileMove(facts: {
  currentParentFolderId: string | null
  expectedParentFolderId: string | null
  targetFolderId: string | null
  fileName: string
  occupiedNamesInTarget: readonly string[]
}): FileMoveDecision {
  if (facts.currentParentFolderId !== facts.expectedParentFolderId) {
    throw new AppException({
      code: ProjectFileErrorCodes.placementChanged,
      msg: '文件所在文件夹已变化'
    })
  }
  if (facts.currentParentFolderId === facts.targetFolderId) return { changed: false }
  if (facts.occupiedNamesInTarget.some((name) => sameFileName(name, facts.fileName))) {
    throw new AppException({
      code: ProjectFileErrorCodes.fileNameConflict,
      msg: '该名称已被占用'
    })
  }
  return { changed: true }
}
