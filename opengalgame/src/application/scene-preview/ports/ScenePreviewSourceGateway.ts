import type { SceneIdentity } from '@domain/scenes/models/SceneIdentity'

import type { ScenePreviewSourceFact } from '../models/ScenePreviewSourceFact'

export interface ScenePreviewSourceGateway {
  /**
   * 读取当前工作区产物，并一次返回同源快照、解析、依据、锁定和问题。
   * @throws {AppException} 场景不可用或内容不可读。不写文件，不启动引擎。
   */
  readScenePreviewSource(scene: SceneIdentity): Promise<ScenePreviewSourceFact>
}
