import type { ProjectFileAssetKind } from './ProjectInputSourceVO'

/** 一次受控媒体读取的字节。不包含工程路径。 */
export type ProjectMediaVO = {
  sourceId: string
  contentKind: ProjectFileAssetKind
  fileName: string
  mediaType: string
  bytes: Uint8Array
}
