import type { SceneContentBasisVO } from '@application/scene-preview/vo/ScenePreviewSessionVO'

export type SceneExportVersionReference = {
  readonly kind: 'preview-save'
  readonly requestId: string
}

export type WindowsScenePackageVO = {
  readonly executableName: 'WebGAL.exe'
  readonly directoryName: string
  /** 产物目录的绝对路径；展示层只读，打开目录仍由服务端校验。 */
  readonly directoryPath: string
  readonly bytes: number
  readonly containsFixedEngine: true
  readonly entryRelativePath: string
  readonly contentBasis: SceneContentBasisVO
  readonly versionReference: SceneExportVersionReference
}

export type SceneExportResultVO =
  | { readonly status: 'exporting' }
  | { readonly status: 'succeeded'; readonly artifact: WindowsScenePackageVO }
  | { readonly status: 'failed'; readonly message: string }
  | {
      readonly status: 'unavailable'
      readonly reason: 'windowsPackagerUnavailable'
      readonly message: string
    }
