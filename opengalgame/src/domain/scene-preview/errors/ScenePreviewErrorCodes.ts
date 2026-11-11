export const ScenePreviewErrorCodes = {
  invalidSceneIdentity: 4501,
  duplicateDialogueId: 4502,
  invalidSnapshotEntry: 4503,
  emptyEditSet: 4504,
  duplicateEditDialogueId: 4505,
  dialogueTargetMissing: 4506,
  dialogueNotEditable: 4507,
  invalidDialogueText: 4508,
  blankDialogueText: 4509,
  blankDialogueId: 4510,
  candidateSessionMissing: 4511,
  candidateSessionExpired: 4512,
  candidateSessionMismatch: 4513,
  candidateSourceForbidden: 4514,
  candidateSourceUnavailable: 4515,
  candidateSourceChanged: 4516,
  candidateCompatibilityUnavailable: 4517
} as const

export type ScenePreviewErrorCode =
  (typeof ScenePreviewErrorCodes)[keyof typeof ScenePreviewErrorCodes]

export const scenePreviewErrorMessages: Record<ScenePreviewErrorCode, string> = {
  [ScenePreviewErrorCodes.invalidSceneIdentity]: '场景身份无效',
  [ScenePreviewErrorCodes.duplicateDialogueId]: '台词身份重复',
  [ScenePreviewErrorCodes.invalidSnapshotEntry]: '台词快照无效',
  [ScenePreviewErrorCodes.emptyEditSet]: '没有要保存的台词正文',
  [ScenePreviewErrorCodes.duplicateEditDialogueId]: '同一次修改不能重复同一句台词',
  [ScenePreviewErrorCodes.dialogueTargetMissing]: '要修改的台词不在当前场景',
  [ScenePreviewErrorCodes.dialogueNotEditable]: '这句台词不能修改',
  [ScenePreviewErrorCodes.invalidDialogueText]: '台词正文无效',
  [ScenePreviewErrorCodes.blankDialogueText]: '台词正文不能为空',
  [ScenePreviewErrorCodes.blankDialogueId]: '台词身份无效',
  [ScenePreviewErrorCodes.candidateSessionMissing]: '候选预览会话不存在',
  [ScenePreviewErrorCodes.candidateSessionExpired]: '候选预览会话已过期',
  [ScenePreviewErrorCodes.candidateSessionMismatch]: '候选预览会话与当前场景不一致',
  [ScenePreviewErrorCodes.candidateSourceForbidden]: '候选源不可读取',
  [ScenePreviewErrorCodes.candidateSourceUnavailable]: '候选源暂时不可用',
  [ScenePreviewErrorCodes.candidateSourceChanged]: '候选内容在读取期间发生了变化',
  [ScenePreviewErrorCodes.candidateCompatibilityUnavailable]: '候选预览版本事实不可用'
}
