import type { ProjectFolderVO } from '@application/project-files/vo/ProjectInputCatalogVO'
import type { ProjectInputSourceSummaryVO } from '@application/project-files/vo/ProjectInputSourceVO'

import { filterInputSources } from './inputCatalogFilters'
import type {
  CatalogFolderId,
  CatalogGroup,
  CatalogTreeEntry,
  CatalogTypeFilter
} from './inputCatalog.types'

export function sortFolders(folders: readonly ProjectFolderVO[]): ProjectFolderVO[] {
  return [...folders].sort((left, right) => left.name.localeCompare(right.name, 'zh'))
}

export function sortSources(
  sources: readonly ProjectInputSourceSummaryVO[]
): ProjectInputSourceSummaryVO[] {
  return [...sources].sort((left, right) => left.name.localeCompare(right.name, 'zh'))
}

/**
 * 指定父目录下的直接子文件夹。
 * @param parentFolderId - 父目录，根为 null。
 */
export function childFolders(
  folders: readonly ProjectFolderVO[],
  parentFolderId: CatalogFolderId
): ProjectFolderVO[] {
  return sortFolders(folders.filter((folder) => folder.parentFolderId === parentFolderId))
}

/**
 * @param parentFolderId - 父目录，根为 null。
 */
export function childSources(
  sources: readonly ProjectInputSourceSummaryVO[],
  parentFolderId: CatalogFolderId
): ProjectInputSourceSummaryVO[] {
  return sortSources(sources.filter((source) => source.parentFolderId === parentFolderId))
}

/** 从根到当前文件夹的面包屑，不含虚拟根。 */
export function breadcrumbFolders(
  folders: readonly ProjectFolderVO[],
  folderId: CatalogFolderId
): ProjectFolderVO[] {
  if (folderId === null) return []
  const byId = new Map(folders.map((folder) => [folder.folderId, folder]))
  const chain: ProjectFolderVO[] = []
  const seen = new Set<string>()
  let current: CatalogFolderId = folderId
  while (current) {
    if (seen.has(current)) break
    seen.add(current)
    const folder = byId.get(current)
    if (!folder) break
    chain.unshift(folder)
    current = folder.parentFolderId
  }
  return chain
}

/** 目录刷新后去掉已经不存在的尾部路径，回到仍存在的祖先。 */
export function pruneFolderTrail(
  folders: readonly ProjectFolderVO[],
  trail: readonly string[]
): string[] {
  const ids = new Set(folders.map((folder) => folder.folderId))
  const next = [...trail]
  while (next.length > 0 && !ids.has(next[next.length - 1]!)) next.pop()
  return next
}

export function folderPathLabel(
  folders: readonly ProjectFolderVO[],
  folderId: CatalogFolderId
): string {
  const names = breadcrumbFolders(folders, folderId).map((folder) => folder.name)
  return names.length > 0 ? names.join(' / ') : '工程根'
}

export function currentFolderEntries(
  folders: readonly ProjectFolderVO[],
  sources: readonly ProjectInputSourceSummaryVO[],
  parentFolderId: CatalogFolderId
): CatalogTreeEntry[] {
  const path = folderPathLabel(folders, parentFolderId)
  return [
    ...childFolders(folders, parentFolderId).map((folder) => ({
      kind: 'folder' as const,
      folder,
      path
    })),
    ...childSources(sources, parentFolderId).map((source) => ({
      kind: 'source' as const,
      source,
      path
    }))
  ]
}

export function searchCatalogEntries(
  folders: readonly ProjectFolderVO[],
  sources: readonly ProjectInputSourceSummaryVO[],
  query: string,
  group: CatalogGroup,
  type: CatalogTypeFilter
): CatalogTreeEntry[] {
  const needle = query.trim().toLowerCase()
  const matchedSources = filterInputSources(sources, query, group, type)
  const folderHits = sortFolders(
    folders.filter((folder) => folder.name.toLowerCase().includes(needle))
  ).map((folder) => ({
    kind: 'folder' as const,
    folder,
    path: folderPathLabel(folders, folder.parentFolderId)
  }))
  const sourceHits = sortSources(matchedSources).map((source) => ({
    kind: 'source' as const,
    source,
    path: folderPathLabel(folders, source.parentFolderId)
  }))
  return [...folderHits, ...sourceHits]
}

/** 目标是否为指定文件夹自身或其后代，复制时禁止作为粘贴位置。 */
export function isForbiddenFolderCopyTarget(
  folders: readonly ProjectFolderVO[],
  folderId: string,
  targetFolderId: CatalogFolderId
): boolean {
  if (targetFolderId === null) return false
  if (targetFolderId === folderId) return true
  const byId = new Map(folders.map((folder) => [folder.folderId, folder]))
  const seen = new Set<string>()
  let current: CatalogFolderId = targetFolderId
  while (current) {
    if (current === folderId) return true
    if (seen.has(current)) return true
    seen.add(current)
    current = byId.get(current)?.parentFolderId ?? null
  }
  return false
}
