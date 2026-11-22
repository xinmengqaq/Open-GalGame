export type ProjectFolder = {
  folderId: string
  parentFolderId: string | null
  name: string
}

export type ProjectSourcePlacement = {
  sourceId: string
  parentFolderId: string | null
}

export type ProjectInputCatalog = {
  folders: readonly ProjectFolder[]
  placements: readonly ProjectSourcePlacement[]
}
