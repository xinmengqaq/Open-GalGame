import type { SceneIdentity } from '@domain/scenes/models/SceneIdentity'

export type ScenePreviewArtifactReport =
  | { readonly status: 'available' }
  | { readonly status: 'missing' }
  | { readonly status: 'unreadable' }

export interface ScenePreviewArtifactGateway {
  /**
   * 只判断当前场景入口存在、非空且能解析出台词。
   * 不返回正文，不查询生成历史或提交记录。
   */
  readSceneArtifact(scene: SceneIdentity): Promise<ScenePreviewArtifactReport>
}
