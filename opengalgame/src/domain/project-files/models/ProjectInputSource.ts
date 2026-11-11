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

/** 扫描得到的来源摘要。不包含正文、媒体字节或本机路径。 */
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
