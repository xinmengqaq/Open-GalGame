import { lstat, readFile } from 'node:fs/promises'

import type { PreparedProjectFileChange } from '@application/project-files/ports/ProjectFileOperationGateway'
import { AppException } from '@common/errors/AppException'
import { ProjectFileErrorCodes } from '@domain/project-files/errors/ProjectFileErrorCodes'
import type { ProjectFolder } from '@domain/project-files/models/ProjectInputCatalog'
import { resolveContained } from '@infrastructure/git/containedPath'
import { toCatalogDocument } from '../reading/ProjectInputCatalogReader'
import { MAX_JSON_BYTES, PROJECT_CATALOG_PATH } from '../projectFilePaths'

/**
 * 把已校验目录编码为目录文件变更。空目录删除已有记录，不补建空文件。
 * @returns 目录变更；没有变化时为空。
 * @throws {AppException} 目录超过 JSON 上限。
 */
export async function prepareProjectCatalogChange(
  projectRoot: string,
  projectId: string,
  folders: readonly ProjectFolder[],
  placements: readonly { sourceId: string; parentFolderId: string }[]
): Promise<readonly PreparedProjectFileChange[]> {
  const exists = await catalogExists(projectRoot)
  if (folders.length === 0 && placements.length === 0) {
    return exists ? [{ relativePath: PROJECT_CATALOG_PATH, action: 'delete' }] : []
  }
  const bytes = Buffer.from(
    `${JSON.stringify(toCatalogDocument(projectId, folders, placements), null, 2)}\n`,
    'utf8'
  )
  if (bytes.byteLength > MAX_JSON_BYTES) {
    throw new AppException({
      code: ProjectFileErrorCodes.catalogCapacityExceeded,
      msg: '目录记录超出限制'
    })
  }
  if (exists && (await sameCatalogBytes(projectRoot, bytes))) return []
  return [
    {
      relativePath: PROJECT_CATALOG_PATH,
      action: exists ? 'modify' : 'add',
      bytes
    }
  ]
}

async function sameCatalogBytes(projectRoot: string, bytes: Buffer): Promise<boolean> {
  try {
    const absolutePath = await resolveContained(projectRoot, PROJECT_CATALOG_PATH)
    const current = await readFile(absolutePath)
    return Buffer.compare(current, bytes) === 0
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

async function catalogExists(projectRoot: string): Promise<boolean> {
  try {
    const absolutePath = await resolveContained(projectRoot, PROJECT_CATALOG_PATH)
    const stats = await lstat(absolutePath)
    return stats.isFile() && !stats.isSymbolicLink()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}
