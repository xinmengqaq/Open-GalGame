import type { ProjectFileAssetKind } from './ProjectInputSourceVO'

export type ProjectMediaVO = {
  sourceId: string
  contentKind: ProjectFileAssetKind
  fileName: string
  mediaType: string
  bytes: Uint8Array
}
