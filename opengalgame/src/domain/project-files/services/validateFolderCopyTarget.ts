import { AppException } from '@common/errors/AppException'
import { ProjectFileErrorCodes } from '../errors/ProjectFileErrorCodes'
import type { ProjectFolder } from '../models/ProjectInputCatalog'

/**
 * 拒绝把文件夹复制到自身或其后代。
 * @param targetFolderId - 粘贴目标。根目录为 null。
 * @throws {AppException} 目标是自身或后代，或目标文件夹不存在。
 */
export function validateFolderCopyTarget(
  folders: readonly ProjectFolder[],
  folderId: string,
  targetFolderId: string | null
): void {
  if (targetFolderId === null) return
  if (targetFolderId === folderId) throw illegal()
  const byId = new Map(folders.map((folder) => [folder.folderId, folder]))
  if (!byId.has(folderId) || !byId.has(targetFolderId)) throw missing()
  let current: string | null = targetFolderId
  const seen = new Set<string>()
  while (current !== null) {
    if (current === folderId) throw illegal()
    if (seen.has(current)) throw illegal()
    seen.add(current)
    current = byId.get(current)?.parentFolderId ?? null
  }
}

function illegal(): AppException {
  return new AppException({
    code: ProjectFileErrorCodes.illegalCopyTarget,
    msg: '不能把文件夹复制到自身或子文件夹'
  })
}

function missing(): AppException {
  return new AppException({
    code: ProjectFileErrorCodes.folderMissing,
    msg: '文件夹不存在'
  })
}
