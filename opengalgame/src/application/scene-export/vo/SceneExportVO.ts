import type { SceneExportContentBasis } from './SceneExportContentBasis'

/**
 * 导出绑定的正式版本引用。
 * 预览保存用自己的 requestId；生成提交用发起生成的 operationId 与正式提交标识。
 */
export type SceneExportVersionReference =
  | {
      readonly kind: 'preview-save'
      readonly requestId: string
    }
  | {
      readonly kind: 'generation-commit'
      readonly operationId: string
      readonly commitId: string
    }

export type WindowsScenePackageVO = {
  readonly executableName: 'WebGAL.exe'
  readonly directoryName: string
  readonly directoryPath: string
  readonly bytes: number
  readonly containsFixedEngine: true
  readonly entryRelativePath: string
  readonly contentBasis: SceneExportContentBasis
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
