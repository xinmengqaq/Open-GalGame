import type { ProjectFilesInspectionVO } from '../vo/ProjectFilesInspectionVO'
import type {
  ProjectFileAssetSourceVO,
  ProjectInputSourceSummaryVO,
  ProjectInputSourcesSnapshotVO,
  ProjectInputSourceVO
} from '../vo/ProjectInputSourceVO'
import type { ProjectFileInspection } from '@domain/project-files/models/ProjectFileDiagnostic'
import type {
  ProjectFileAssetSource,
  ProjectInputSource,
  ProjectInputSourceSummary
} from '@domain/project-files/models/ProjectInputSource'

export function toProjectInputSourceSummaryVO(
  summary: ProjectInputSourceSummary,
  parentFolderId: string | null
): ProjectInputSourceSummaryVO {
  if (summary.contentKind === 'text') {
    return {
      sourceId: summary.sourceId,
      name: summary.name,
      readable: summary.readable,
      parentFolderId,
      contentKind: 'text',
      textKind: summary.textKind
    }
  }
  return {
    sourceId: summary.sourceId,
    name: summary.name,
    readable: summary.readable,
    parentFolderId,
    contentKind: summary.contentKind
  }
}

export function toProjectInputSourceVO(source: ProjectInputSource): ProjectInputSourceVO {
  switch (source.contentKind) {
    case 'text':
      return {
        sourceId: source.sourceId,
        version: source.version,
        contentKind: 'text',
        textKind: 'document',
        title: source.title,
        body: source.body,
        topics: [...source.topics],
        importInfo: { format: source.importFormat }
      }
    default:
      return toAssetSourceVO(source)
  }
}

export function toProjectInputSourcesSnapshotVO(
  projectId: string,
  readVersion: string,
  sources: readonly ProjectInputSource[]
): ProjectInputSourcesSnapshotVO {
  return {
    projectId,
    readVersion,
    sources: sources.map(toProjectInputSourceVO)
  }
}

export function toProjectFilesInspectionVO(
  inspection: ProjectFileInspection
): ProjectFilesInspectionVO {
  return {
    projectId: inspection.projectId,
    inputSourceFormatSupported: inspection.inputSourceFormatSupported,
    canvasArrangementFormatSupported: inspection.canvasArrangementFormatSupported,
    diagnostics: inspection.diagnostics.map((diagnostic) => ({
      objectId: diagnostic.objectId,
      kind: diagnostic.kind
    }))
  }
}

function toAssetSourceVO(source: ProjectFileAssetSource): ProjectFileAssetSourceVO {
  return {
    sourceId: source.sourceId,
    version: source.version,
    contentKind: source.contentKind,
    name: source.name,
    fileId: source.fileId,
    description: source.description
  }
}
