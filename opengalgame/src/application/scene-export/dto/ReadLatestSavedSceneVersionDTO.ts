/**
 * 读取该工程该场景最新可导出的正式保存版本。
 * 请求只带工程与场景身份，不携带路径、内容或命令。
 */
export type ReadLatestSavedSceneVersionDTO = {
  readonly projectId: string
  readonly sceneId: string
}
