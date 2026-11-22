export type SceneGenerationScopeDTO = {
  projectId: string
  sceneId: string
  operationId: string
}

export type SceneGenerationThreadDTO = {
  projectId: string
  sceneId: string
  threadId: string
}

export type SceneGenerationBranchDTO = SceneGenerationThreadDTO & { branchId: string }

export type SceneGenerationUsageDTO = {
  characterId?: string
  locationId?: string
  spokenLine?: string
  targetIds: readonly string[]
}

export type SceneConfirmedControlDTO = {
  kind: 'sceneJump' | 'option' | 'condition'
  content: string
  inputId: string
}

export type SceneGenerationPromptScopeDTO =
  | { kind: 'scene' }
  | { kind: 'cards'; cardIds: readonly string[] }
  | { kind: 'relation'; relationId: string }

export type SceneGenerationPromptReferenceDTO = {
  cardId: string
  kind: 'document' | 'image' | 'audio' | 'video' | 'animation' | 'effect'
  displayName: string
}

export type SceneInputSelectionDTO = {
  canvasId: string
  confirmedControls: readonly SceneConfirmedControlDTO[]
}

export type SceneGenerationInputsDTO = {
  canvasId: string
  arrangementVersion: string
  assets: readonly {
    assetId: string
    sourceId: string
    name: string
    relativePath: string
    category: 'image' | 'audio' | 'video'
    description: string
    usage: SceneGenerationUsageDTO
  }[]
  documents: readonly {
    id: string
    sourceId: string
    title: string
    summary: string
    body: string
    topics: readonly string[]
    usage: SceneGenerationUsageDTO
  }[]
  prompts: readonly {
    id: string
    title: string
    body: string
    scopes: readonly SceneGenerationPromptScopeDTO[]
    references: readonly SceneGenerationPromptReferenceDTO[]
    usage: SceneGenerationUsageDTO
  }[]
  fieldBindings: readonly {
    cardId: string
    kind: 'animation' | 'effect'
    command: string | null
    name: string | null
    usage: SceneGenerationUsageDTO
  }[]
  relations: readonly {
    relationId: string
    fromCardId: string
    toCardId: string
    defaultRelation:
      'actsOn' | 'accompanies' | 'voices' | 'depicts' | 'constrains' | 'sameSubject' | 'associated'
    specificName: string
    record:
      | { kind: 'document'; cardId: string; sourceId: string }
      | { kind: 'prompt'; cardId: string }
      | null
  }[]
  confirmedControls: readonly SceneConfirmedControlDTO[]
}

export type SceneGenerationPolicyDTO = {
  maxCorrections: number
}

export type GenerateSceneDTO = SceneGenerationScopeDTO & {
  inputs: SceneInputSelectionDTO
  branch?: { threadId: string; branchId: string }
  policy: SceneGenerationPolicyDTO
  reviewCandidate?: boolean
  expectedArrangementVersion?: string
}
export type StartSceneGenerationDTO = {
  projectId: string
  sceneId: string
  canvasId: string
  confirmedControls: readonly SceneConfirmedControlDTO[]
  policy: SceneGenerationPolicyDTO
}

export type RetrySceneGenerationRepairDTO = StartSceneGenerationDTO & {
  repair: {
    sourceOperationId: string
    sourceThreadId: string
    sourceBranchId: string
    sourceCheckpointId: string
    candidateSnapshotId: string
    instruction: string
  }
}

export type ResumeSceneGenerationDTO = SceneGenerationBranchDTO & {
  operationId: string
  checkpointId: string
  candidateSnapshotId?: string
}

/**
 * 未完成操作和无检查点提交后清理都只按操作身份核对，不接受检查点、候选或路径。
 * 是否可继续/可重试由应用按持久事实决定，不能由调用方补造。
 */
export type SceneGenerationRecoveryScopeDTO = SceneGenerationBranchDTO & {
  operationId: string
}

/** 通过既有 resume 通道表达的无检查点恢复；不是 checkpointId 可选。 */
export type ResumeUnfinishedSceneGenerationDTO = SceneGenerationRecoveryScopeDTO & {
  recovery: 'unfinished'
}

/** 通过既有 resume 通道表达的提交后清理重试；不重开生成。 */
export type RetrySceneGenerationCleanupDTO = SceneGenerationRecoveryScopeDTO & {
  recovery: 'cleanup'
}

/** 通过既有 resume 通道表达的待核对结果重新核对；只读证据，不新增提交。 */
export type VerifyUnknownSceneGenerationDTO = SceneGenerationRecoveryScopeDTO & {
  recovery: 'verify'
}

export type SceneGenerationResumeRequestDTO =
  | ResumeSceneGenerationDTO
  | ResumeUnfinishedSceneGenerationDTO
  | RetrySceneGenerationCleanupDTO
  | VerifyUnknownSceneGenerationDTO

export type ListSceneGenerationHistoryForSceneDTO = {
  projectId: string
  sceneId: string
  /** 历史页游标：上一页最后一条历史摘要的 checkpointId。 */
  cursor?: string
  limit: number
  /**
   * 需要作者处理的操作页游标：上一页最后一条的 operationId。
   * 与历史 cursor 互斥，避免两类分页位置混用。
   */
  unfinishedCursor?: string
  /** 需要作者处理的操作页大小；与历史 limit 独立，默认 100。 */
  unfinishedLimit?: number
}

/**
 * 只读分页列出需要作者显式处理的操作：尚未结束且没有检查点的遗留、
 * 带检查点但写入/提交回执待核对的中断，以及会阻止新普通生成的非终态 generate。
 * 不接受操作、线程或检查点身份。
 */
export type ListUnfinishedSceneGenerationsDTO = {
  projectId: string
  sceneId: string
  /** 上一页最后一条的 operationId；只在同一排序内推进。 */
  cursor?: string
  limit?: number
}

export type OpenSceneGenerationCandidatePreviewDTO = SceneGenerationBranchDTO & {
  operationId: string
  checkpointId: string
  candidateSnapshotId: string
}

export type CloseSceneGenerationCandidatePreviewDTO = SceneGenerationScopeDTO & {
  previewSessionId: string
}

export type SceneGenerationQuestionAnswerDTO = {
  questionId: string
  optionId: string
  body?: string
}

export type SceneGenerationAnswerFactDTO = {
  questionId: string
  prompt: string
  optionId: string
  label: string
  description: string
  body?: string
}

export type SceneGenerationReplyDTO =
  | { kind: 'accept' | 'discard' }
  | { kind: 'clarify' | 'revise'; body: string }
  | { kind: 'select'; optionId: string; body?: string }
  | { kind: 'answers'; answers: readonly SceneGenerationQuestionAnswerDTO[] }

export type ReplySceneGenerationInteractionDTO = SceneGenerationBranchDTO & {
  operationId: string
  interactionId: string
  checkpointId: string
  candidateSnapshotId?: string
  replyId: string
  reply: SceneGenerationReplyDTO
  selection?: {
    optionId: string
    label: string
    description: string
    body?: string
  }
  selections?: readonly SceneGenerationAnswerFactDTO[]
}

export type ListSceneGenerationHistoryDTO = SceneGenerationBranchDTO & {
  cursor?: string
  limit: number
}

export type ReadSceneGenerationCheckpointDTO = SceneGenerationBranchDTO & {
  checkpointId: string
}

export type ForkSceneGenerationDTO = ReadSceneGenerationCheckpointDTO & {
  operationId: string
  inputChanges?: SceneInputSelectionDTO
  decisionChanges?: readonly { interactionId: string; reply: SceneGenerationReplyDTO }[]
  policy: SceneGenerationPolicyDTO
  reviewCandidate?: boolean
}

/**
 * 从 AI 历史创建分叉的公开请求：只交来源分支、检查点和已批准策略。
 * 新操作身份由应用层生成，不接受输入或决定变更。
 */
export type ForkSceneGenerationFromHistoryDTO = SceneGenerationBranchDTO & {
  checkpointId: string
  policy: SceneGenerationPolicyDTO
}

export type EditSceneGenerationCandidateDTO = SceneGenerationScopeDTO & {
  candidateSnapshotId: string
  files: readonly { relativePath: string; content: string }[]
}
