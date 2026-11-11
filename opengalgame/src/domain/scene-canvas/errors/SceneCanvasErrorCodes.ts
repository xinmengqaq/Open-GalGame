export const SceneCanvasErrorCodes = {
  identityConflict: 4401,
  targetMissing: 4402,
  fieldNotApplicable: 4403,
  invalidField: 4404,
  selfConnection: 4405,
  duplicateRelation: 4406,
  invalidRecordKind: 4407,
  promptRecordOccupied: 4408,
  persistFailed: 4411,
  commitFailed: 4412,
  commitUnknown: 4413,
  identityMismatch: 4414,
  sourceUnreadable: 4415,
  contentDamaged: 4416,
  unsupportedFormat: 4417,
  ownershipMismatch: 4418,
  readFailed: 4419,
  pathEscapesProject: 4420,
  readChanged: 4421
} as const

export type SceneCanvasErrorCode =
  (typeof SceneCanvasErrorCodes)[keyof typeof SceneCanvasErrorCodes]
