export const SceneGenerationErrorCodes = {
  blankProjectId: 4201,
  blankSceneId: 4202,
  blankAssetId: 4203,
  duplicateAssetId: 4204,
  blankSourceId: 4205,
  blankDocumentId: 4206,
  duplicateDocumentId: 4207,
  blankDocumentTitle: 4208,
  blankDocumentBody: 4209,
  blankPromptId: 4210,
  duplicatePromptId: 4211,
  blankPromptBody: 4212,
  blankConfirmedContent: 4213,
  unknownConfirmedInput: 4214,
  // 场景生成自身仍使用这些码。数值与版本模块当前技术失败码相同，不能改。
  gitNotRepository: 5201,
  gitUnavailable: 5202,
  gitNoCommits: 5203,
  gitQueryFailed: 5204,
  sceneSourceMissing: 5205,
  sceneSourceIgnored: 5206
} as const

export type SceneGenerationErrorCode =
  (typeof SceneGenerationErrorCodes)[keyof typeof SceneGenerationErrorCodes]
