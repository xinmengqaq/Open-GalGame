export type ProjectTextSourceKind = 'document'

export type ProjectFileAssetKind = 'image' | 'audio' | 'video'

export type ProjectInputContentKind = 'text' | ProjectFileAssetKind

type ProjectInputSourceSummaryBase = {
  sourceId: string
  name: string
  readable: boolean
  parentFolderId: string | null
}

export type ProjectInputSourceSummaryVO =
  | (ProjectInputSourceSummaryBase & {
      contentKind: 'text'
      textKind: ProjectTextSourceKind
    })
  | (ProjectInputSourceSummaryBase & {
      contentKind: ProjectFileAssetKind
    })

type ProjectInputSourceIdentity = {
  sourceId: string
  version: string
}

export type ProjectDocumentImportFormat = 'markdown' | 'plainText'

export type ProjectDocumentImportInfoVO = {
  format: ProjectDocumentImportFormat
}

export type ProjectDocumentSourceVO = ProjectInputSourceIdentity & {
  contentKind: 'text'
  textKind: 'document'
  title: string
  body: string
  topics: readonly string[]
  importInfo: ProjectDocumentImportInfoVO
}

export type ProjectFileAssetSourceVO = ProjectInputSourceIdentity & {
  contentKind: ProjectFileAssetKind
  name: string
  fileId: string
  description: string
}

export type ProjectInputSourceVO = ProjectDocumentSourceVO | ProjectFileAssetSourceVO

export type ImportProjectFilesVO = {
  importedFiles: readonly ProjectInputSourceSummaryVO[]
  failedFiles: readonly {
    fileName: string
    message: string
  }[]
}

export type ProjectInputSourcesSnapshotVO = {
  projectId: string
  readVersion: string
  sources: readonly ProjectInputSourceVO[]
}
