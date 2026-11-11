export type ProjectTextSourceKind = 'document'

/** 实际文件类型。场景用途留在卡片，不在来源上区分背景、立绘或配音。 */
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
  /** 来源内容版本。只用于判断该来源是否变化，不是作品提交身份。 */
  version: string
}

export type ProjectDocumentImportFormat = 'markdown' | 'plainText'

/** 文档导入时确认的格式。不包含本机路径。 */
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
  /** 本次读取版本。只用于判断这次读取的内容是否变化，不是作品提交身份。 */
  readVersion: string
  sources: readonly ProjectInputSourceVO[]
}
