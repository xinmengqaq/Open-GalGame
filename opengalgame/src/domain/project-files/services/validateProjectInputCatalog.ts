import { AppException } from '@common/errors/AppException'
import { ProjectFileErrorCodes } from '../errors/ProjectFileErrorCodes'
import type {
  ProjectFolder,
  ProjectInputCatalog,
  ProjectSourcePlacement
} from '../models/ProjectInputCatalog'

export type CatalogNameFact = {
  id: string
  parentFolderId: string | null
  name: string
}

/**
 * @param names - 参与同一父目录名称空间的文件夹和来源名称。
 * @throws {AppException} 目录结构无法可靠确定。
 */
export function validateProjectInputCatalog(
  catalog: ProjectInputCatalog,
  names: readonly CatalogNameFact[]
): void {
  const folders = indexFolders(catalog.folders)
  assertPlacements(catalog.placements, folders)
  assertNames(names, folders)
}

function indexFolders(folders: readonly ProjectFolder[]): Map<string, ProjectFolder> {
  const byId = new Map<string, ProjectFolder>()
  for (const folder of folders) {
    if (folder.folderId.trim() === '' || byId.has(folder.folderId)) throw damaged()
    byId.set(folder.folderId, folder)
  }
  for (const folder of folders) {
    if (folder.parentFolderId === folder.folderId) throw damaged()
    if (folder.parentFolderId !== null && !byId.has(folder.parentFolderId)) throw damaged()
    assertNoCycle(folder, byId)
  }
  return byId
}

function assertNoCycle(folder: ProjectFolder, byId: ReadonlyMap<string, ProjectFolder>): void {
  const seen = new Set<string>()
  let current: string | null = folder.folderId
  while (current !== null) {
    if (seen.has(current)) throw damaged()
    seen.add(current)
    const node = byId.get(current)
    if (!node) throw damaged()
    current = node.parentFolderId
  }
}

function assertPlacements(
  placements: readonly ProjectSourcePlacement[],
  folders: ReadonlyMap<string, ProjectFolder>
): void {
  const seen = new Set<string>()
  for (const placement of placements) {
    if (placement.sourceId.trim() === '' || seen.has(placement.sourceId)) throw damaged()
    seen.add(placement.sourceId)
    if (placement.parentFolderId !== null && !folders.has(placement.parentFolderId)) {
      throw damaged()
    }
  }
}

function assertNames(
  names: readonly CatalogNameFact[],
  folders: ReadonlyMap<string, ProjectFolder>
): void {
  const occupied = new Map<string, Set<string>>()
  for (const item of names) {
    if (item.id.trim() === '' || item.name.trim() === '') throw damaged()
    if (item.parentFolderId !== null && !folders.has(item.parentFolderId)) throw damaged()
    const key = item.parentFolderId ?? ''
    const namesInParent = occupied.get(key) ?? new Set<string>()
    const folded = item.name.toLowerCase()
    if (namesInParent.has(folded)) throw damaged()
    namesInParent.add(folded)
    occupied.set(key, namesInParent)
  }
}

/** 收集文件夹及其全部后代。缺少目标时返回空数组。 */
export function folderSubtree(
  folders: readonly ProjectFolder[],
  folderId: string
): ProjectFolder[] {
  const result: ProjectFolder[] = []
  const pending = [folderId]
  const seen = new Set<string>()
  while (pending.length > 0) {
    const current = pending.pop()
    if (current === undefined || seen.has(current)) continue
    seen.add(current)
    const folder = folders.find((item) => item.folderId === current)
    if (!folder) continue
    result.push(folder)
    for (const child of folders) {
      if (child.parentFolderId === current) pending.push(child.folderId)
    }
  }
  return result
}

function damaged(): AppException {
  return new AppException({
    code: ProjectFileErrorCodes.catalogDamaged,
    msg: '目录记录损坏'
  })
}
