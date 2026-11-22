import type {
  ProjectInputSource,
  ProjectInputSourceSummary
} from '@domain/project-files/models/ProjectInputSource'
import type { ProjectInputSourceDocument } from '../documents/ProjectInputSourceDocument'
import { digestVersionParts } from '../projectFilePaths'
import type { SourceCatalogRecord } from '../reading/ProjectInputSourceCatalog'

export function toProjectInputSource(
  document: ProjectInputSourceDocument,
  content: string,
  version: string
): ProjectInputSource {
  const contentKind = document.content.kind
  if (contentKind === 'document') {
    return {
      sourceId: document.sourceId,
      version,
      contentKind: 'text',
      textKind: 'document',
      title: document.content.title,
      body: content,
      topics: [...document.content.topics],
      importFormat: document.content.importFormat
    }
  }
  return {
    sourceId: document.sourceId,
    version,
    contentKind: document.content.fileType,
    name: document.content.name,
    fileId: document.content.fileId,
    description: document.content.description
  }
}

export function toSourceSummary(
  record: SourceCatalogRecord,
  readable: boolean
): ProjectInputSourceSummary | null {
  if (!('document' in record) || record.document === undefined) return null
  const content = record.document.content
  const sourceId = record.claimedId ?? record.document.sourceId
  if (content.kind === 'document') {
    return {
      sourceId,
      name: content.title,
      readable,
      contentKind: 'text',
      textKind: 'document'
    }
  }
  return {
    sourceId,
    name: content.name,
    readable,
    contentKind: content.fileType
  }
}

export function toReadVersion(
  projectId: string,
  sources: readonly { sourceId: string; version: string }[]
): string {
  const ordered = [...sources].sort((left, right) =>
    left.sourceId < right.sourceId ? -1 : left.sourceId > right.sourceId ? 1 : 0
  )
  return digestVersionParts([
    'project-file-read-v1',
    projectId,
    ordered.map((source) => [source.sourceId, source.version])
  ])
}
