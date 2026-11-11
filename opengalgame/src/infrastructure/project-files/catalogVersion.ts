import type { ProjectFolder } from '@domain/project-files/models/ProjectInputCatalog'
import { digestVersionParts } from './projectFilePaths'

export type CatalogVersionSource = {
  sourceId: string
  name: string
  parentFolderId: string | null
}

export type DeletionVersionSource = CatalogVersionSource & {
  contentDigest: string
  fileId: string | null
  mediaPath: string | null
}

/** 用规范化目录和来源名称计算目录版本。不读取 JSON 自报字段。 */
export function computeCatalogVersion(
  projectId: string,
  folders: readonly ProjectFolder[],
  sources: readonly CatalogVersionSource[]
): string {
  return digestVersionParts([
    'project-input-catalog-v1',
    projectId,
    [...folders]
      .sort((left, right) => compareText(left.folderId, right.folderId))
      .map((folder) => [folder.folderId, folder.parentFolderId, folder.name]),
    [...sources]
      .sort((left, right) => compareText(left.sourceId, right.sourceId))
      .map((source) => [source.sourceId, source.name, source.parentFolderId])
  ])
}

export function computeDeletionVersion(facts: {
  catalogVersion: string
  folders: readonly ProjectFolder[]
  sources: readonly DeletionVersionSource[]
}): string {
  return digestVersionParts([
    'project-folder-deletion-v1',
    facts.catalogVersion,
    [...facts.folders]
      .sort((left, right) => compareText(left.folderId, right.folderId))
      .map((folder) => [folder.folderId, folder.parentFolderId, folder.name]),
    [...facts.sources]
      .sort((left, right) => compareText(left.sourceId, right.sourceId))
      .map((source) => [
        source.sourceId,
        source.name,
        source.parentFolderId,
        source.contentDigest,
        source.fileId,
        source.mediaPath
      ])
  ])
}

function compareText(left: string, right: string): number {
  if (left < right) return -1
  if (left > right) return 1
  return 0
}
