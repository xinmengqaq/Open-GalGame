import { lstat, readdir, realpath } from 'node:fs/promises'
import { join } from 'node:path'

import type {
  PreparedProjectFileChange,
  SourceCopySpec
} from '@application/project-files/ports/ProjectFileOperationGateway'
import { AppException } from '@common/errors/AppException'
import { ProjectFileErrorCodes } from '@domain/project-files/errors/ProjectFileErrorCodes'
import { resolveContained } from '@infrastructure/git/containedPath'
import { SceneScriptParserGatewayImpl } from '@infrastructure/scenes/SceneScriptParserGatewayImpl'
import { SceneSourceReaderGatewayImpl } from '@infrastructure/scenes/SceneSourceReaderGatewayImpl'
import { projectAssetRelativePaths } from '@infrastructure/webgal/assetPath'
import type { ProjectInputSourceDocument } from '../documents/ProjectInputSourceDocument'
import {
  assertAssetMediaPath,
  encodeStorageKey,
  PROJECT_INPUT_FORMAT_VERSION,
  sourceDescriptorPath
} from '../projectFilePaths'
import { contentRelativePath } from '../sourceContentPath'
import type { SourceCatalogRecord } from '../reading/ProjectInputSourceCatalog'

/**
 * @throws {AppException} 原内容缺失或无法定位。
 */
export async function prepareSourceCopyChanges(
  projectRoot: string,
  document: ProjectInputSourceDocument,
  spec: SourceCopySpec
): Promise<{ changes: PreparedProjectFileChange[]; watchedPaths: string[] }> {
  const currentPath = contentRelativePath(document)
  const absolutePath = await resolveContained(projectRoot, currentPath)
  const watchedPaths = [sourceDescriptorPath(document.sourceId), currentPath]
  if (document.content.kind === 'document') {
    const extension = document.content.importFormat === 'markdown' ? 'md' : 'txt'
    const next: ProjectInputSourceDocument = {
      formatVersion: PROJECT_INPUT_FORMAT_VERSION,
      projectId: document.projectId,
      sourceId: spec.newSourceId,
      content: {
        kind: 'document',
        title: spec.fileName,
        topics: [...document.content.topics],
        importFormat: document.content.importFormat,
        bodyFile: `${encodeStorageKey(spec.newSourceId)}.${extension}`
      }
    }
    return {
      watchedPaths,
      changes: [
        descriptorChange(spec.newSourceId, next),
        {
          relativePath: contentRelativePath(next),
          action: 'add',
          sourceFile: absolutePath
        }
      ]
    }
  }
  const mediaPath = assertAssetMediaPath(
    `assets/${encodeStorageKey(spec.newSourceId)}/${spec.fileName}`
  )
  const next: ProjectInputSourceDocument = {
    formatVersion: PROJECT_INPUT_FORMAT_VERSION,
    projectId: document.projectId,
    sourceId: spec.newSourceId,
    content: {
      kind: 'asset',
      name: spec.fileName,
      fileType: document.content.fileType,
      description: document.content.description,
      fileId: spec.newFileId,
      mediaPath
    }
  }
  return {
    watchedPaths,
    changes: [
      descriptorChange(spec.newSourceId, next),
      { relativePath: mediaPath, action: 'add', sourceFile: absolutePath }
    ]
  }
}

/**
 * 核对删除集合没有共享内容，并准备描述和仍存在的内容删除。
 * @throws {AppException} 记录损坏、归属不明或内容被其他来源引用。
 */
export async function prepareOwnedDeleteChanges(
  projectRoot: string,
  records: readonly SourceCatalogRecord[],
  sourceIds: readonly string[]
): Promise<{ changes: PreparedProjectFileChange[]; watchedPaths: string[] }> {
  assertExclusiveContent(records, new Set(sourceIds))
  const contentPaths = sourceIds.map((sourceId) =>
    contentRelativePath(requireParsed(records, sourceId).document)
  )
  await assertSceneDoesNotReference(projectRoot, contentPaths)
  const changes: PreparedProjectFileChange[] = []
  const watchedPaths: string[] = []
  for (const sourceId of sourceIds) {
    const record = requireParsed(records, sourceId)
    changes.push({ relativePath: sourceDescriptorPath(sourceId), action: 'delete' })
    watchedPaths.push(sourceDescriptorPath(sourceId))
    const relativePath = contentRelativePath(record.document)
    watchedPaths.push(relativePath)
    if (await contentExists(projectRoot, relativePath)) {
      changes.push({ relativePath, action: 'delete' })
    }
  }
  return { changes, watchedPaths }
}

export function requireParsed(
  records: readonly SourceCatalogRecord[],
  sourceId: string
): Extract<SourceCatalogRecord, { status: 'parsed' }> {
  const matches = records.filter(
    (record) => record.filenameId === sourceId || record.claimedId === sourceId
  )
  if (matches.length !== 1 || matches[0]?.status !== 'parsed') {
    throw new AppException({
      code: ProjectFileErrorCodes.catalogDamaged,
      msg: '无法确定内容归属'
    })
  }
  return matches[0]
}

async function assertSceneDoesNotReference(
  projectRoot: string,
  contentPaths: readonly string[]
): Promise<void> {
  if (contentPaths.length === 0) return
  const referenced = await sceneReferencedProjectPaths(projectRoot)
  if (contentPaths.some((path) => referenced.has(path))) {
    throw new AppException({
      code: ProjectFileErrorCodes.contentReferenceConflict,
      msg: '内容仍被其他来源引用'
    })
  }
}

async function sceneReferencedProjectPaths(projectRoot: string): Promise<Set<string>> {
  const directory = await resolveContained(projectRoot, 'game/scene')
  let names: string[]
  try {
    names = (await readdir(directory, { recursive: true })).map((name) => name.toString())
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR') return new Set()
    throw error
  }
  const reader = new SceneSourceReaderGatewayImpl()
  const parser = new SceneScriptParserGatewayImpl()
  const referenced = new Set<string>()
  for (const name of names) {
    const relativeName = name.replaceAll('\\', '/')
    if (!relativeName.endsWith('.txt')) continue
    const relativePath = `game/scene/${relativeName}`
    const snapshot = await reader.readSceneSource({
      projectRoot,
      entryFile: relativePath,
      sceneFiles: [],
      metadataFiles: []
    })
    const scene = parser.parseSceneScript(snapshot, relativePath)
    for (const asset of scene.assets) {
      if (asset.isCleared) continue
      for (const path of projectAssetRelativePaths(asset.kind, asset.rawReference)) {
        referenced.add(path)
      }
    }
  }
  return referenced
}

function assertExclusiveContent(
  records: readonly SourceCatalogRecord[],
  deleting: ReadonlySet<string>
): void {
  const owners = new Map<string, string>()
  for (const record of records) {
    if (record.status !== 'parsed') {
      throw new AppException({
        code: ProjectFileErrorCodes.catalogDamaged,
        msg: '无法确定内容归属'
      })
    }
    if (record.document.content.kind !== 'asset') continue
    rememberOwner(owners, record.document.content.mediaPath, record.document.sourceId, deleting)
    rememberOwner(owners, record.document.content.fileId, record.document.sourceId, deleting)
  }
}

function rememberOwner(
  owners: Map<string, string>,
  key: string,
  sourceId: string,
  deleting: ReadonlySet<string>
): void {
  const previous = owners.get(key)
  if (previous === undefined) {
    owners.set(key, sourceId)
    return
  }
  const sharedAcrossDelete = deleting.has(previous) !== deleting.has(sourceId)
  if (previous !== sourceId && sharedAcrossDelete) {
    throw new AppException({
      code: ProjectFileErrorCodes.contentReferenceConflict,
      msg: '内容仍被其他来源引用'
    })
  }
}

function descriptorChange(
  sourceId: string,
  document: ProjectInputSourceDocument
): PreparedProjectFileChange {
  return {
    relativePath: sourceDescriptorPath(sourceId),
    action: 'add',
    bytes: Buffer.from(`${JSON.stringify(document, null, 2)}\n`, 'utf8')
  }
}

async function contentExists(projectRoot: string, relativePath: string): Promise<boolean> {
  const lexical = join(await realpath(projectRoot), ...relativePath.split('/'))
  let stats: Awaited<ReturnType<typeof lstat>>
  try {
    stats = await lstat(lexical)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
  if (stats.isSymbolicLink()) {
    await resolveContained(projectRoot, relativePath)
    throw new AppException({
      code: ProjectFileErrorCodes.fileOperationFailed,
      msg: '内容是符号链接，已拒绝删除'
    })
  }
  return stats.isFile()
}
