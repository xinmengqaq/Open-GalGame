/** 逻辑文件夹。根目录不是文件夹，父身份为 null。 */
export type ProjectFolder = {
  folderId: string
  parentFolderId: string | null
  name: string
}

/** 来源在目录中的归属。根目录归属的父身份为 null。 */
export type ProjectSourcePlacement = {
  sourceId: string
  parentFolderId: string | null
}

/** 已解析的逻辑目录。不包含路径、正文或媒体字节。 */
export type ProjectInputCatalog = {
  folders: readonly ProjectFolder[]
  placements: readonly ProjectSourcePlacement[]
}
