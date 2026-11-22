export type ProjectDocumentImportFormat = 'markdown' | 'plainText'

export type ProjectFileAssetKind = 'image' | 'audio' | 'video'

export type ProjectInputSourceIdentity = {
  sourceId: string
  version: string
}

export type ProjectDocumentSource = ProjectInputSourceIdentity & {
  contentKind: 'text'
  textKind: 'document'
  title: string
  body: string
  topics: readonly string[]
  importFormat: ProjectDocumentImportFormat
}

export type ProjectFileAssetSource = ProjectInputSourceIdentity & {
  contentKind: ProjectFileAssetKind
  name: string
  fileId: string
  description: string
}

export type ProjectInputSource = ProjectDocumentSource | ProjectFileAssetSource

export type ProjectInputSourceSummary =
  | {
      sourceId: string
      name: string
      readable: boolean
      contentKind: 'text'
      textKind: 'document'
    }
  | {
      sourceId: string
      name: string
      readable: boolean
      contentKind: ProjectFileAssetKind
    }
