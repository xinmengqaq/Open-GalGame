import { AppException } from '@common/errors/AppException'
import { ProjectFileErrorCodes } from '../errors/ProjectFileErrorCodes'
import type { ProjectFolder } from '../models/ProjectInputCatalog'
import { requireSingleFileName, sameFileName } from './fileNameFacts'

const MAX_COPY_SUFFIX = 9999

export type FolderRenameDecision = { changed: false } | { changed: true; name: string }

export function requireFolderName(name: string): void {
  requireSingleFileName(name)
}

export function evaluateFolderRename(
  currentName: string,
  newName: string,
  occupiedNames: readonly string[]
): FolderRenameDecision {
  requireFolderName(currentName)
  requireFolderName(newName)
  if (sameFileName(currentName, newName)) return { changed: false }
  if (occupiedNames.some((name) => sameFileName(name, newName))) {
    throw new AppException({
      code: ProjectFileErrorCodes.fileNameConflict,
      msg: '该名称已被占用'
    })
  }
  return { changed: true, name: newName }
}

export function chooseFolderCopyName(name: string, occupiedNames: readonly string[]): string {
  requireFolderName(name)
  if (!occupiedNames.some((occupied) => sameFileName(occupied, name))) return name
  for (let index = 1; index <= MAX_COPY_SUFFIX; index += 1) {
    const candidate = `${name} (${index})`
    if (!occupiedNames.some((occupied) => sameFileName(occupied, candidate))) return candidate
  }
  throw new AppException({
    code: ProjectFileErrorCodes.importNameExhausted,
    msg: '没有可用的文件夹名'
  })
}

export function namesInParent(
  folders: readonly ProjectFolder[],
  sourceNames: readonly { sourceId: string; name: string; parentFolderId: string | null }[],
  parentFolderId: string | null,
  exceptId?: string
): string[] {
  return [
    ...folders
      .filter((folder) => folder.parentFolderId === parentFolderId && folder.folderId !== exceptId)
      .map((folder) => folder.name),
    ...sourceNames
      .filter((source) => source.parentFolderId === parentFolderId && source.sourceId !== exceptId)
      .map((source) => source.name)
  ]
}
