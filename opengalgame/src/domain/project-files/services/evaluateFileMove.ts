import { AppException } from '@common/errors/AppException'
import { ProjectFileErrorCodes } from '../errors/ProjectFileErrorCodes'
import { sameFileName } from './fileNameFacts'

export type FileMoveDecision = { changed: false } | { changed: true }

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
