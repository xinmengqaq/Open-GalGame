/**
 * 读取该工程该场景最近一次已结算的预览保存版本。
 * 请求只带工程与场景身份，不携带路径、内容或命令。
 */
export type ReadLatestPreviewSaveDTO = {
  readonly projectId: string
  readonly sceneId: string
}
