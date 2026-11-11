import type { CatalogSourceFact } from '@application/project-files/models/ProjectInputCatalogReadFacts'
import { AppException } from '@common/errors/AppException'
import { ProjectFileErrorCodes } from '@domain/project-files/errors/ProjectFileErrorCodes'
import type { ProjectFolder } from '@domain/project-files/models/ProjectInputCatalog'
import { validateProjectInputCatalog } from '@domain/project-files/services/validateProjectInputCatalog'
import { computeCatalogVersion } from '../catalogVersion'
import { parseJsonDocumentContent } from '@infrastructure/storage/jsonDocument'
import { parseUnknownValue } from '@infrastructure/validation/parseUnknownValue'
import {
  projectInputCatalogDocumentSchema,
  type ProjectInputCatalogDocument
} from '../documents/ProjectInputCatalogDocument'
import { PROJECT_CATALOG_PATH } from '../projectFilePaths'
import type { ProjectFileReadWindow } from './ProjectFileReadWindow'

export type LoadedInputCatalog = {
  folders: readonly ProjectFolder[]
  placements: readonly { sourceId: string; parentFolderId: string }[]
}

/**
 * 读取逻辑目录。文件不存在表示尚未建立目录，不创建文件。
 * @throws {AppException} 文件存在但损坏、版本不受支持或工程身份不符。
 */
export async function loadInputCatalog(window: ProjectFileReadWindow): Promise<LoadedInputCatalog> {
  const file = await window.readOptionalText(PROJECT_CATALOG_PATH)
  if (file === null) return { folders: [], placements: [] }
  let value: unknown
  try {
    value = parseJsonDocumentContent(file.text, {
      code: ProjectFileErrorCodes.catalogDamaged,
      msg: '目录记录损坏'
    })
  } catch (error) {
    if (error instanceof AppException) {
      throw new AppException({
        code: ProjectFileErrorCodes.catalogDamaged,
        msg: '目录记录损坏',
        cause: error
      })
    }
    throw error
  }
  const document = parseUnknownValue(
    projectInputCatalogDocumentSchema,
    value,
    ProjectFileErrorCodes.catalogDamaged,
    '目录记录损坏'
  )
  if (document.projectId !== window.projectId) {
    throw new AppException({
      code: ProjectFileErrorCodes.catalogDamaged,
      msg: '目录记录损坏'
    })
  }
  return { folders: document.folders, placements: document.placements }
}

export function toCatalogDocument(
  projectId: string,
  folders: readonly ProjectFolder[],
  placements: readonly { sourceId: string; parentFolderId: string }[]
): ProjectInputCatalogDocument {
  return {
    formatVersion: 1,
    projectId,
    folders: [...folders].sort((left, right) => compareText(left.folderId, right.folderId)),
    placements: [...placements].sort((left, right) => compareText(left.sourceId, right.sourceId))
  }
}

/**
 * 核对归属和名称空间，并计算目录版本。
 * @param sources - 带来源名称的摘要，父目录由调用方填入。
 * @throws {AppException} 归属或名称空间无法确定。
 */
export function assertJoinedCatalog(
  projectId: string,
  loaded: LoadedInputCatalog,
  sources: readonly CatalogSourceFact[]
): string {
  const sourceIds = new Set<string>()
  const duplicateIds = new Set<string>()
  for (const source of sources) {
    if (sourceIds.has(source.sourceId)) duplicateIds.add(source.sourceId)
    sourceIds.add(source.sourceId)
  }
  for (const placement of loaded.placements) {
    if (!sourceIds.has(placement.sourceId)) {
      throw new AppException({
        code: ProjectFileErrorCodes.catalogDamaged,
        msg: '目录记录损坏'
      })
    }
  }
  const placements = sources
    .filter((source) => !duplicateIds.has(source.sourceId))
    .map((source) => ({
      sourceId: source.sourceId,
      parentFolderId: source.parentFolderId
    }))
  validateProjectInputCatalog({ folders: loaded.folders, placements }, [
    ...loaded.folders.map((folder) => ({
      id: folder.folderId,
      parentFolderId: folder.parentFolderId,
      name: folder.name
    })),
    ...sources
      .filter((source) => !duplicateIds.has(source.sourceId) && source.name.trim() !== '')
      .map((source) => ({
        id: source.sourceId,
        parentFolderId: source.parentFolderId,
        name: source.name
      }))
  ])
  return computeCatalogVersion(projectId, loaded.folders, sources)
}

function compareText(left: string, right: string): number {
  if (left < right) return -1
  if (left > right) return 1
  return 0
}
