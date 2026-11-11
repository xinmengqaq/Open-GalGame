import type {
  CatalogSourceFact,
  ProjectFolderDeletionReadFact,
  ProjectInputCatalogReadFact
} from '@application/project-files/models/ProjectInputCatalogReadFacts'
import type {
  ProjectInputSourceInspectionFact,
  ProjectInputSourcesReadFact,
  ProjectInputSourceSummary,
  VerifiedProjectReadLocation
} from '@application/project-files/models/ProjectInputSourceReadFacts'
import type { ProjectInputSourceReaderGateway } from '@application/project-files/ports/ProjectInputSourceReaderGateway'
import { AppException } from '@common/errors/AppException'
import { ProjectFileErrorCodes } from '@domain/project-files/errors/ProjectFileErrorCodes'
import type { ProjectInputSourceFact } from '@domain/project-files/models/ProjectFileDiagnostic'
import type { ProjectInputSource } from '@domain/project-files/models/ProjectInputSource'
import { folderSubtree } from '@domain/project-files/services/validateProjectInputCatalog'
import { computeDeletionVersion } from './catalogVersion'
import { toReadVersion, toSourceSummary } from './mapping/ProjectFileReadFactsMapper'
import {
  assertJoinedCatalog,
  loadInputCatalog,
  type LoadedInputCatalog
} from './reading/ProjectInputCatalogReader'
import { contentRelativePath } from './sourceContentPath'
import {
  catalogSourceId,
  loadSourceCatalog,
  type SourceCatalogRecord
} from './reading/ProjectInputSourceCatalog'
import type { ProjectInputSourceDocument } from './documents/ProjectInputSourceDocument'
import { probeSourceReadable, readSourceContent } from './reading/ProjectInputSourceContentReader'
import { withProjectFileRead, type ProjectFileReadWindow } from './reading/ProjectFileReadWindow'
import { StableFileReadError } from '@infrastructure/storage/StableProjectFileReader'

/** 本机工程输入来源读取适配。不执行领域合法性判断。 */
export class LocalProjectInputSourceReaderGatewayImpl implements ProjectInputSourceReaderGateway {
  /** 扫描来源摘要，不加载全部正文或媒体字节。 */
  scanProjectInputSources(
    project: VerifiedProjectReadLocation
  ): Promise<readonly ProjectInputSourceSummary[]> {
    return withProjectFileRead(project.location.directory, project.projectId, async (window) => {
      const records = await loadSourceCatalog(window)
      const summaries: ProjectInputSourceSummary[] = []
      for (const record of records) {
        if (record.status === 'unsupported') continue
        const readable =
          record.status === 'parsed' && (await probeSourceReadable(window, record.document))
        const summary = toSourceSummary(record, readable)
        if (summary === null) {
          throw new AppException({
            code: ProjectFileErrorCodes.contentDamaged,
            msg: '工程文件内容损坏'
          })
        }
        summaries.push(summary)
      }
      return summaries
    })
  }

  inspectProjectInputSources(
    project: VerifiedProjectReadLocation
  ): Promise<ProjectInputSourceInspectionFact> {
    return withProjectFileRead(project.location.directory, project.projectId, async (window) => {
      const records = await loadSourceCatalog(window)
      let inputSourceFormatSupported = true
      const sources: ProjectInputSourceFact[] = []
      for (const record of records) {
        const sourceId = catalogSourceId(record)
        if (record.status === 'unsupported') {
          inputSourceFormatSupported = false
          continue
        }
        if (record.status === 'damaged') {
          sources.push({ availability: 'damaged', sourceId })
          continue
        }
        try {
          const content = await readSourceContent(window, record)
          if (content.status === 'present') {
            sources.push({ availability: 'present', source: content.source })
          } else {
            sources.push({ availability: content.status, sourceId })
          }
        } catch (error) {
          if (
            error instanceof AppException &&
            error.code === ProjectFileErrorCodes.unsupportedFormat
          ) {
            inputSourceFormatSupported = false
            continue
          }
          throw error
        }
      }
      let catalogDamaged = false
      try {
        const loaded = await loadInputCatalog(window)
        const named = namedSources(records)
        if (named === null) catalogDamaged = true
        else joinSources(window.projectId, loaded, named)
      } catch (error) {
        if (error instanceof AppException && error.code === ProjectFileErrorCodes.catalogDamaged) {
          catalogDamaged = true
        } else {
          throw error
        }
      }
      return {
        projectId: window.projectId,
        inputSourceFormatSupported,
        sources,
        catalogDamaged
      }
    })
  }

  /** 读取一致目录快照。不创建缺失的目录文件。 */
  readProjectInputCatalog(
    project: VerifiedProjectReadLocation
  ): Promise<ProjectInputCatalogReadFact> {
    return withProjectFileRead(project.location.directory, project.projectId, async (window) => {
      const records = await loadSourceCatalog(window)
      const loaded = await loadInputCatalog(window)
      return joinSources(window.projectId, loaded, await readableSummaries(window, records, loaded))
    })
  }

  /** 读取文件夹删除计划。子树无法完整确定时失败。 */
  readFolderDeletionPlan(
    project: VerifiedProjectReadLocation,
    folderId: string
  ): Promise<ProjectFolderDeletionReadFact> {
    return withProjectFileRead(project.location.directory, project.projectId, async (window) => {
      const records = await loadSourceCatalog(window)
      const loaded = await loadInputCatalog(window)
      const catalog = joinSources(
        window.projectId,
        loaded,
        await readableSummaries(window, records, loaded)
      )
      const subtree = folderSubtree(catalog.folders, folderId)
      const root = subtree.find((folder) => folder.folderId === folderId)
      if (!root) {
        throw new AppException({
          code: ProjectFileErrorCodes.folderMissing,
          msg: '文件夹不存在'
        })
      }
      const folderIds = new Set(subtree.map((folder) => folder.folderId))
      const selected = catalog.sources.filter(
        (source) => source.parentFolderId !== null && folderIds.has(source.parentFolderId)
      )
      const deletionSources: {
        sourceId: string
        name: string
        parentFolderId: string | null
        contentDigest: string
        fileId: string | null
        mediaPath: string | null
      }[] = []
      for (const source of selected) {
        const record = records.find(
          (item) => item.status === 'parsed' && item.document.sourceId === source.sourceId
        )
        if (!record || record.status !== 'parsed') {
          throw new AppException({
            code: ProjectFileErrorCodes.catalogDamaged,
            msg: '无法确定内容归属'
          })
        }
        deletionSources.push({
          sourceId: source.sourceId,
          name: source.name,
          parentFolderId: source.parentFolderId,
          contentDigest: await contentDigest(window, record.document),
          fileId: record.document.content.kind === 'asset' ? record.document.content.fileId : null,
          mediaPath:
            record.document.content.kind === 'asset' ? record.document.content.mediaPath : null
        })
      }
      return {
        folderId,
        name: root.name,
        catalogVersion: catalog.catalogVersion,
        folderCount: subtree.length,
        fileCount: selected.length,
        deletionVersion: computeDeletionVersion({
          catalogVersion: catalog.catalogVersion,
          folders: subtree,
          sources: deletionSources
        })
      }
    })
  }

  readProjectInputSources(
    project: VerifiedProjectReadLocation,
    sourceIds: readonly string[]
  ): Promise<ProjectInputSourcesReadFact> {
    return withProjectFileRead(project.location.directory, project.projectId, async (window) => {
      const records = await loadSourceCatalog(window)
      const sources: ProjectInputSource[] = []
      for (const sourceId of sourceIds) {
        sources.push(await readRequestedSource(records, sourceId, window))
      }
      return {
        projectId: window.projectId,
        readVersion: toReadVersion(window.projectId, sources),
        sources
      }
    })
  }
}

async function readableSummaries(
  window: ProjectFileReadWindow,
  records: readonly SourceCatalogRecord[],
  loaded: LoadedInputCatalog
): Promise<CatalogSourceFact[]> {
  const sources: CatalogSourceFact[] = []
  for (const record of records) {
    if (record.status === 'unsupported') continue
    const readable =
      record.status === 'parsed' && (await probeSourceReadable(window, record.document))
    const summary = toSourceSummary(record, readable)
    if (summary === null) {
      throw new AppException({
        code: ProjectFileErrorCodes.contentDamaged,
        msg: '工程文件内容损坏'
      })
    }
    sources.push({
      ...summary,
      parentFolderId: parentOf(loaded, summary.sourceId)
    })
  }
  return sources
}

function namedSources(records: readonly SourceCatalogRecord[]): CatalogSourceFact[] | null {
  const sources: CatalogSourceFact[] = []
  for (const record of records) {
    if (record.status === 'unsupported') continue
    const summary = toSourceSummary(record, false)
    if (summary === null) return null
    sources.push({ ...summary, parentFolderId: null })
  }
  return sources
}

function joinSources(
  projectId: string,
  loaded: LoadedInputCatalog,
  sources: CatalogSourceFact[]
): ProjectInputCatalogReadFact {
  const placed = sources.map((source) => ({
    ...source,
    parentFolderId: parentOf(loaded, source.sourceId)
  }))
  return {
    projectId,
    catalogVersion: assertJoinedCatalog(projectId, loaded, placed),
    folders: loaded.folders,
    sources: placed
  }
}

function parentOf(loaded: LoadedInputCatalog, sourceId: string): string | null {
  return (
    loaded.placements.find((placement) => placement.sourceId === sourceId)?.parentFolderId ?? null
  )
}

async function contentDigest(
  window: ProjectFileReadWindow,
  document: ProjectInputSourceDocument
): Promise<string> {
  const relativePath = contentRelativePath(document)
  try {
    if (document.content.kind === 'asset') return (await window.readMedia(relativePath)).digest
    const file = await window.readOptionalBytes(relativePath)
    return file?.digest ?? 'missing'
  } catch (error) {
    if (error instanceof StableFileReadError && error.kind === 'missing') return 'missing'
    throw error
  }
}

async function readRequestedSource(
  records: readonly SourceCatalogRecord[],
  sourceId: string,
  window: ProjectFileReadWindow
): Promise<ProjectInputSource> {
  const matches = records.filter(
    (record) => record.filenameId === sourceId || record.claimedId === sourceId
  )
  if (matches.length === 0) {
    throw new AppException({
      code: ProjectFileErrorCodes.sourceMissing,
      msg: '来源不存在'
    })
  }
  if (matches.length > 1) {
    throw new AppException({
      code: ProjectFileErrorCodes.duplicateSourceId,
      msg: '同一次读取不能重复登记同一来源'
    })
  }
  const record = matches[0]!
  if (record.status === 'unsupported') {
    throw new AppException({
      code: ProjectFileErrorCodes.unsupportedFormat,
      msg: '工程文件格式不受支持'
    })
  }
  if (record.status !== 'parsed') {
    throw new AppException({
      code: ProjectFileErrorCodes.contentDamaged,
      msg: '工程文件内容损坏'
    })
  }
  if (record.document.projectId !== window.projectId) {
    throw new AppException({
      code: ProjectFileErrorCodes.ownershipMismatch,
      msg: '工程文件归属不匹配'
    })
  }
  const content = await readSourceContent(window, record)
  if (content.status === 'missing') {
    throw new AppException({
      code: ProjectFileErrorCodes.sourceMissing,
      msg: '来源不存在'
    })
  }
  if (content.status !== 'present') {
    throw new AppException({
      code: ProjectFileErrorCodes.contentDamaged,
      msg: '工程文件内容损坏'
    })
  }
  return content.source
}
