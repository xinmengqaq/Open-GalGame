export const FailureReasons = {
  promptReferenceDuplicate: 'promptReferenceDuplicate',
  promptReferenceTargetMissing: 'promptReferenceTargetMissing',
  /** 仓储按操作标识查询确认记录不存在；检查点读取失败不带此原因。 */
  sceneGenerationOperationMissing: 'sceneGenerationOperationMissing'
} as const
