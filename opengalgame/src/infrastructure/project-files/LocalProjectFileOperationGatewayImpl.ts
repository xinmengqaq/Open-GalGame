import { lstat, readFile } from 'node:fs/promises'
import { extname } from 'node:path'

import type { VerifiedProjectReadLocation } from '@application/project-files/models/ProjectInputSourceReadFacts'
import type {
  CatalogWriteFact,
  InspectedImportFile,
  LocatedProjectFile,
  PreparedCatalogMutation,
  PreparedProjectFileChange,
  ProjectFileOperationGateway,
  SourceCopySpec,
  TextBodyUpdateSpec,
  TextCreateSpec
} from '@application/project-files/ports/ProjectFileOperationGateway'
import type { ProjectMediaVO } from '@application/project-files/vo/ProjectMediaVO'
import { AppException } from '@common/errors/AppException'
import { ProjectFileErrorCodes } from '@domain/project-files/errors/ProjectFileErrorCodes'
import { resolveContained } from '@infrastructure/git/containedPath'
import {
  identifyMediaFormat,
  mediaFormatMatchesFileType
} from '@infrastructure/media/identifyMediaFormat'
import {
  assertOrdinaryProjectFile,
  decodeStrictUtf8,
  readProjectFilePrefix
} from '@infrastructure/storage/StableProjectFileReader'
import type { ProjectInputSourceDocument } from './documents/ProjectInputSourceDocument'
import { assertPersistableFileName, fileNameFromPath } from './importFileName'
import { readSourceContent } from './reading/ProjectInputSourceContentReader'
import { loadSourceCatalog } from './reading/ProjectInputSourceCatalog'
import { withProjectFileRead } from './reading/ProjectFileReadWindow'
import {
  assertAssetMediaPath,
  documentBodyPath,
  encodeStorageKey,
  MAX_MEDIA_BYTES,
  MAX_TEXT_CHARS,
  PROJECT_CATALOG_PATH,
  PROJECT_INPUT_FORMAT_VERSION,
  sourceDescriptorPath
} from './projectFilePaths'
import { prepareProjectCatalogChange } from './writing/prepareProjectCatalogChange'
import { contentRelativePath } from './sourceContentPath'
import {
  prepareOwnedDeleteChanges,
  prepareSourceCopyChanges
} from './writing/prepareProjectSubtreeChanges'

const TEXT_EXTENSIONS = new Map<string, 'markdown' | 'plainText'>([
  ['.md', 'markdown'],
  ['.txt', 'plainText']
])
const MEDIA_PREFIX_BYTES = 8192
/** SVG 需要完整文档才能解析，超过这个大小就不再整份读入。 */
const SVG_PARSE_LIMIT_BYTES = 1_048_576

/** 本机工程文件的定位和写入准备。正式写入由作品版本端口执行。 */
export class LocalProjectFileOperationGatewayImpl implements ProjectFileOperationGateway {
  /** 识别工程外文件。普通格式问题返回失败事实。 */
  async inspectImportFile(
    _project: VerifiedProjectReadLocation,
    localFilePath: string
  ): Promise<InspectedImportFile> {
    const fileName = fileNameFromPath(localFilePath)
    try {
      const stats = await lstat(localFilePath)
      if (!stats.isFile() || stats.isSymbolicLink()) {
        return { ok: false, fileName, message: '文件格式不受支持' }
      }
      const extension = extname(fileName).toLowerCase()
      const textFormat = TEXT_EXTENSIONS.get(extension)
      if (textFormat) {
        if (stats.size > MAX_TEXT_CHARS * 4) {
          return { ok: false, fileName, message: '文件格式不受支持' }
        }
        readImportText(await readFile(localFilePath))
        return { ok: true, fileName, fileType: 'document', importFormat: textFormat }
      }
      const prefix = await readProjectFilePrefix(localFilePath, MEDIA_PREFIX_BYTES)
      let identified = await identifyMediaFormat(prefix)
      if (!identified.supported && extension === '.svg') {
        if (stats.size > SVG_PARSE_LIMIT_BYTES) {
          return { ok: false, fileName, message: '文件格式不受支持' }
        }
        identified = await identifyMediaFormat(await readFile(localFilePath))
      }
      if (!identified.supported) return { ok: false, fileName, message: '文件格式不受支持' }
      return { ok: true, fileName, fileType: identified.category }
    } catch (error) {
      if (error instanceof AppException) {
        return { ok: false, fileName, message: error.message }
      }
      return { ok: false, fileName, message: '文件无法读取' }
    }
  }

  /** 用来源记录中的显示名作为占用事实。 */
  async listOccupiedFileNames(project: VerifiedProjectReadLocation): Promise<readonly string[]> {
    return withProjectFileRead(project.location.directory, project.projectId, async (window) => {
      const records = await loadSourceCatalog(window)
      return records.flatMap((record) => {
        if (record.status !== 'parsed') return []
        return [displayName(record.document)]
      })
    })
  }

  /** 准备来源记录和内容字节，不写入正式工程。 */
  async prepareImport(
    _project: VerifiedProjectReadLocation,
    sourceId: string,
    fileName: string,
    localFilePath: string
  ): Promise<readonly PreparedProjectFileChange[]> {
    assertPersistableFileName(fileName)
    const inspected = await this.inspectImportFile(_project, localFilePath)
    if (!inspected.ok || inspected.fileType === undefined) {
      throw new AppException({
        code: ProjectFileErrorCodes.unsupportedFormat,
        msg: inspected.ok ? '文件格式不受支持' : inspected.message
      })
    }
    if (inspected.fileType === 'document') {
      const bytes = await readFile(localFilePath)
      const extension = inspected.importFormat === 'markdown' ? 'md' : 'txt'
      const body = readImportText(bytes)
      return [
        descriptorChange(sourceId, {
          formatVersion: PROJECT_INPUT_FORMAT_VERSION,
          projectId: _project.projectId,
          sourceId,
          content: {
            kind: 'document',
            title: fileName,
            topics: [],
            importFormat: inspected.importFormat ?? 'plainText',
            bodyFile: `${encodeStorageKey(sourceId)}.${extension}`
          }
        }),
        {
          relativePath: documentBodyPath(sourceId, extension),
          action: 'add',
          bytes: Buffer.from(body, 'utf8')
        }
      ]
    }
    const mediaPath = assertAssetMediaPath(`assets/${encodeStorageKey(sourceId)}/${fileName}`)
    return [
      descriptorChange(sourceId, {
        formatVersion: PROJECT_INPUT_FORMAT_VERSION,
        projectId: _project.projectId,
        sourceId,
        content: {
          kind: 'asset',
          name: fileName,
          fileType: inspected.fileType,
          description: '',
          fileId: sourceId,
          mediaPath
        }
      }),
      { relativePath: mediaPath, action: 'add', sourceFile: localFilePath }
    ]
  }

  async locateProjectFile(
    project: VerifiedProjectReadLocation,
    sourceId: string
  ): Promise<LocatedProjectFile> {
    const document = await requireDocument(project, sourceId)
    const relativePath = contentRelativePath(document)
    return {
      sourceId,
      fileName: displayName(document),
      contentKind: document.content.kind === 'asset' ? document.content.fileType : 'text',
      ...(document.content.kind === 'document' ? { textKind: 'document' as const } : {}),
      readable: true,
      absolutePath: await resolveContained(project.location.directory, relativePath)
    }
  }

  /** 读取已登记素材的完整字节。描述和内容在同一次读取窗口内核对。 */
  async readProjectMedia(
    project: VerifiedProjectReadLocation,
    sourceId: string
  ): Promise<ProjectMediaVO> {
    return withProjectFileRead(project.location.directory, project.projectId, async (window) => {
      const records = await loadSourceCatalog(window)
      const record = records.find(
        (item) => item.status === 'parsed' && item.document.sourceId === sourceId
      )
      if (!record || record.status !== 'parsed') {
        throw new AppException({
          code: ProjectFileErrorCodes.sourceRecordMissing,
          msg: '来源记录不存在'
        })
      }
      const document = record.document
      if (document.content.kind !== 'asset') {
        throw new AppException({
          code: ProjectFileErrorCodes.unsupportedFormat,
          msg: '文本来源不能作为媒体读取'
        })
      }
      const mediaPath = assertAssetMediaPath(document.content.mediaPath)
      await assertOrdinaryProjectFile(window.root, mediaPath)
      const media = await window.readBytes(mediaPath, MAX_MEDIA_BYTES)
      const identified = await identifyMediaFormat(media.bytes)
      if (
        !identified.supported ||
        !mediaFormatMatchesFileType(document.content.fileType, identified)
      ) {
        throw new AppException({
          code: ProjectFileErrorCodes.unsupportedFormat,
          msg: '文件格式不受支持'
        })
      }
      return {
        sourceId,
        contentKind: document.content.fileType,
        fileName: document.content.name,
        mediaType: identified.mediaType,
        bytes: media.bytes
      }
    })
  }

  /** 准备文件名变更和记录更新。文本正文仍按来源身份存放。 */
  async prepareRename(
    project: VerifiedProjectReadLocation,
    sourceId: string,
    newFileName: string
  ): Promise<readonly PreparedProjectFileChange[]> {
    assertPersistableFileName(newFileName)
    const document = await requireDocument(project, sourceId)
    const next = renamedDocument(document, newFileName)
    const changes: PreparedProjectFileChange[] = [descriptorChange(sourceId, next, 'modify')]
    if (document.content.kind === 'asset' && next.content.kind === 'asset') {
      const currentPath = assertAssetMediaPath(document.content.mediaPath)
      changes.push(
        { relativePath: currentPath, action: 'delete' },
        {
          relativePath: next.content.mediaPath,
          action: 'add',
          sourceFile: await resolveContained(project.location.directory, currentPath)
        }
      )
    }
    return changes
  }

  async prepareDelete(
    project: VerifiedProjectReadLocation,
    sourceId: string
  ): Promise<readonly PreparedProjectFileChange[]> {
    await requireDocument(project, sourceId)
    return (await this.prepareOwnedDeletes(project, [sourceId])).changes
  }

  async prepareCatalogWrite(
    project: VerifiedProjectReadLocation,
    catalog: CatalogWriteFact
  ): Promise<PreparedCatalogMutation> {
    for (const folder of catalog.folders) assertPersistableFileName(folder.name)
    return {
      changes: await prepareProjectCatalogChange(
        project.location.directory,
        project.projectId,
        catalog.folders,
        catalog.placements
      ),
      watchedPaths: [PROJECT_CATALOG_PATH]
    }
  }

  async prepareTextCreate(
    project: VerifiedProjectReadLocation,
    spec: TextCreateSpec
  ): Promise<readonly PreparedProjectFileChange[]> {
    assertPersistableFileName(spec.fileName)
    if (spec.body.length > MAX_TEXT_CHARS) {
      throw new AppException({
        code: ProjectFileErrorCodes.unsupportedFormat,
        msg: '文件格式不受支持'
      })
    }
    const extension = spec.format === 'markdown' ? 'md' : 'txt'
    const document: ProjectInputSourceDocument = {
      formatVersion: PROJECT_INPUT_FORMAT_VERSION,
      projectId: project.projectId,
      sourceId: spec.sourceId,
      content: {
        kind: 'document',
        title: spec.fileName,
        topics: [],
        importFormat: spec.format,
        bodyFile: `${encodeStorageKey(spec.sourceId)}.${extension}`
      }
    }
    return [
      descriptorChange(spec.sourceId, document),
      {
        relativePath: documentBodyPath(spec.sourceId, extension),
        action: 'add',
        bytes: Buffer.from(spec.body, 'utf8')
      }
    ]
  }

  async prepareTextUpdate(
    project: VerifiedProjectReadLocation,
    spec: TextBodyUpdateSpec
  ): Promise<readonly PreparedProjectFileChange[]> {
    if (spec.body.length > MAX_TEXT_CHARS) {
      throw new AppException({
        code: ProjectFileErrorCodes.unsupportedFormat,
        msg: '文件格式不受支持'
      })
    }
    return withProjectFileRead(project.location.directory, project.projectId, async (window) => {
      const records = await loadSourceCatalog(window)
      const record = records.find(
        (item) => item.status === 'parsed' && item.document.sourceId === spec.sourceId
      )
      if (!record || record.status !== 'parsed') {
        throw new AppException({
          code: ProjectFileErrorCodes.sourceRecordMissing,
          msg: '来源记录不存在'
        })
      }
      if (record.document.content.kind !== 'document') {
        throw new AppException({
          code: ProjectFileErrorCodes.unsupportedFormat,
          msg: '文件格式不受支持'
        })
      }
      const read = await readSourceContent(window, record)
      if (read.status !== 'present') {
        throw new AppException({
          code: ProjectFileErrorCodes.contentDamaged,
          msg: '工程文件内容损坏'
        })
      }
      if (read.source.version !== spec.expectedVersion) {
        throw new AppException({
          code: ProjectFileErrorCodes.textBodyChanged,
          msg: '正文已变化，请重新核对'
        })
      }
      const extension = record.document.content.importFormat === 'markdown' ? 'md' : 'txt'
      return [
        {
          relativePath: documentBodyPath(spec.sourceId, extension),
          action: 'modify',
          bytes: Buffer.from(spec.body, 'utf8')
        }
      ]
    })
  }

  async prepareFileCopy(
    project: VerifiedProjectReadLocation,
    spec: SourceCopySpec
  ): Promise<PreparedCatalogMutation> {
    assertPersistableFileName(spec.fileName)
    const document = await requireDocument(project, spec.sourceId)
    return prepareSourceCopyChanges(project.location.directory, document, spec)
  }

  async prepareSubtreeCopy(
    project: VerifiedProjectReadLocation,
    copies: readonly SourceCopySpec[]
  ): Promise<PreparedCatalogMutation> {
    const changes: PreparedProjectFileChange[] = []
    const watchedPaths: string[] = []
    for (const spec of copies) {
      assertPersistableFileName(spec.fileName)
      const prepared = await this.prepareFileCopy(project, spec)
      changes.push(...prepared.changes)
      watchedPaths.push(...prepared.watchedPaths)
    }
    return { changes, watchedPaths }
  }

  async prepareOwnedDeletes(
    project: VerifiedProjectReadLocation,
    sourceIds: readonly string[]
  ): Promise<PreparedCatalogMutation> {
    return withProjectFileRead(project.location.directory, project.projectId, async (window) => {
      const records = await loadSourceCatalog(window)
      return prepareOwnedDeleteChanges(project.location.directory, records, sourceIds)
    })
  }
}

function displayName(document: ProjectInputSourceDocument): string {
  if (document.content.kind === 'document') return document.content.title
  return document.content.name
}

function renamedMediaPath(sourceId: string, currentPath: string, fileName: string): string {
  const prefix = `assets/${encodeStorageKey(sourceId)}/`
  if (currentPath.startsWith(prefix)) return assertAssetMediaPath(`${prefix}${fileName}`)
  return assertAssetMediaPath(`assets/${fileName}`)
}

function renamedDocument(
  document: ProjectInputSourceDocument,
  fileName: string
): ProjectInputSourceDocument {
  if (document.content.kind === 'document') {
    return { ...document, content: { ...document.content, title: fileName } }
  }
  return {
    ...document,
    content: {
      ...document.content,
      name: fileName,
      mediaPath: renamedMediaPath(document.sourceId, document.content.mediaPath, fileName)
    }
  }
}

function descriptorChange(
  sourceId: string,
  document: ProjectInputSourceDocument,
  action: 'add' | 'modify' = 'add'
): PreparedProjectFileChange {
  return {
    relativePath: sourceDescriptorPath(sourceId),
    action,
    bytes: Buffer.from(`${JSON.stringify(document, null, 2)}\n`, 'utf8')
  }
}

function readImportText(bytes: Uint8Array): string {
  if (bytes.byteLength > MAX_TEXT_CHARS * 4) {
    throw new AppException({
      code: ProjectFileErrorCodes.unsupportedFormat,
      msg: '文件格式不受支持'
    })
  }
  try {
    const text = decodeStrictUtf8(bytes)
    if (text.length > MAX_TEXT_CHARS) {
      throw new AppException({
        code: ProjectFileErrorCodes.unsupportedFormat,
        msg: '文件格式不受支持'
      })
    }
    return text
  } catch (error) {
    if (error instanceof AppException) throw error
    throw new AppException({
      code: ProjectFileErrorCodes.unsupportedFormat,
      msg: '文件格式不受支持'
    })
  }
}

async function requireDocument(
  project: VerifiedProjectReadLocation,
  sourceId: string
): Promise<ProjectInputSourceDocument> {
  return withProjectFileRead(project.location.directory, project.projectId, async (window) => {
    const records = await loadSourceCatalog(window)
    const record = records.find(
      (item) => item.status === 'parsed' && item.document.sourceId === sourceId
    )
    if (!record || record.status !== 'parsed') {
      throw new AppException({
        code: ProjectFileErrorCodes.sourceRecordMissing,
        msg: '来源记录不存在'
      })
    }
    return record.document
  })
}
