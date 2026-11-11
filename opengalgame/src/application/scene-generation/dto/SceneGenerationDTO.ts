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

/** 提示词绑定的当前画布卡片事实。类别由卡片 kind 给出，不携带角色用途。 */
export type SceneGenerationPromptReferenceDTO = {
  cardId: string
  kind: 'document' | 'image' | 'audio' | 'video' | 'animation' | 'effect'
  displayName: string
}

/** 指定要读取的已保存编排，以及本次人工确认的控制。 */
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
  /** 生成前已核对的编排版本。存在时与重读快照不一致则不创建操作。 */
  expectedArrangementVersion?: string
}
/** B 版启动只提交稳定身份、已确认控制和策略；操作身份由应用层创建。 */
export type StartSceneGenerationDTO = {
  projectId: string
  sceneId: string
  canvasId: string
  confirmedControls: readonly SceneConfirmedControlDTO[]
  policy: SceneGenerationPolicyDTO
}

/**
 * 非中断修复重跑只传来源身份和用户确认的修改正文。
 * 不接收路径、检查点内部或模型原文；来源候选只作为只读参考。
 */
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

/** 恢复必须绑定当前操作、线程分支、检查点和候选修订，不接受调用方路径。 */
export type ResumeSceneGenerationDTO = SceneGenerationBranchDTO & {
  operationId: string
  checkpointId: string
  candidateSnapshotId?: string
}

export type ListSceneGenerationHistoryForSceneDTO = {
  projectId: string
  sceneId: string
  cursor?: string
  limit: number
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

/** 服务端确认后的一题事实。请求不带题干和选项标题。 */
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
  /** 领域确认后的选项标题、说明和自由文本。请求可以不带，接受后由应用层写入。 */
  selection?: {
    optionId: string
    label: string
    description: string
    body?: string
  }
  /** 领域按当前问题构造的整组事实。请求不带，接受后由应用层写入。 */
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

export type EditSceneGenerationCandidateDTO = SceneGenerationScopeDTO & {
  candidateSnapshotId: string
  files: readonly { relativePath: string; content: string }[]
}
