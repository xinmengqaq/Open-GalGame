import { AppException } from '@common/errors/AppException'
import { ErrorCodes } from '@common/errors/ErrorCodes'

export const SCENE_GENERATION_REPLY_BODY_LIMIT = 2000

const REVIEW_REPLIES: Record<'accept' | 'revise' | 'discard', true> = {
  accept: true,
  revise: true,
  discard: true
}

export type SceneGenerationReplyKind =
  'accept' | 'discard' | 'clarify' | 'revise' | 'select' | 'answers'

export type SceneGenerationPauseInterrupt =
  | 'paused'
  | 'candidateConflict'
  | 'commitUnknown'
  | 'writeUnknown'
  | 'readInterrupted'

export interface SceneGenerationReplyOption {
  readonly id: string
  readonly label: string
  readonly description?: string
}

export interface SceneGenerationReplyQuestion {
  readonly questionId: string
  readonly prompt: string
  readonly detail?: string
  readonly options: readonly SceneGenerationReplyOption[]
}

export interface SceneGenerationReplyInteraction {
  readonly interactionId: string
  readonly checkpointId: string
  readonly kind: 'decision' | 'clarification' | 'correction' | 'review'
  readonly options: readonly SceneGenerationReplyOption[]
  readonly questions?: readonly SceneGenerationReplyQuestion[]
  readonly allowedReplies: readonly SceneGenerationReplyKind[]
  readonly candidateSnapshotId?: string
}

export type SceneGenerationReply =
  | { readonly kind: 'accept' | 'discard' }
  | { readonly kind: 'clarify' | 'revise'; readonly body: string }
  | { readonly kind: 'select'; readonly optionId: string; readonly body?: string }
  | {
      readonly kind: 'answers'
      readonly answers: readonly {
        readonly questionId: string
        readonly optionId: string
        readonly body?: string
      }[]
    }

export interface SceneGenerationReplyExecution {
  readonly projectId: string
  readonly sceneId: string
  readonly operationId: string
  readonly threadId: string
  readonly branchId: string
  readonly state: string
  readonly checkpointId?: string
  readonly candidateSnapshotId?: string
  readonly interaction?: SceneGenerationReplyInteraction
  readonly replies: readonly { readonly replyId: string }[]
  readonly interruptReason?: SceneGenerationPauseInterrupt
}

export interface SceneGenerationReplyRequest {
  readonly projectId: string
  readonly sceneId: string
  readonly operationId: string
  readonly threadId: string
  readonly branchId: string
  readonly interactionId: string
  readonly checkpointId: string
  readonly candidateSnapshotId?: string
  readonly replyId: string
  readonly reply: SceneGenerationReply
}

export interface SceneGenerationReplyCheckpoint {
  readonly checkpointId: string
  readonly operationId: string
  readonly threadId: string
  readonly branchId: string
  readonly canContinue: boolean
  /** 当前等待能否提交已实现的人工回复；省略表示旧记录不能据此回复。 */
  readonly canReply?: boolean
  readonly candidateSnapshotId?: string
}

export interface PublishedSceneGenerationCandidate {
  readonly operationId: string
  readonly threadId: string
  readonly branchId: string
  readonly checkpointId: string
  readonly candidateSnapshotId: string
}

export interface SceneGenerationSelectionFact {
  readonly optionId: string
  readonly label: string
  readonly description: string
  readonly body?: string
}

export interface SceneGenerationAnswerFact {
  readonly questionId: string
  readonly prompt: string
  readonly optionId: string
  readonly label: string
  readonly description: string
  readonly body?: string
}

function requireText(value: string | undefined, message: string): string {
  const text = value?.trim() ?? ''
  if (text === '') throw new AppException({ code: ErrorCodes.invalidRequest, msg: message })
  return text
}

function optionalBody(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  const text = value.trim()
  if (text === '') return undefined
  if ([...text].length > SCENE_GENERATION_REPLY_BODY_LIMIT) {
    throw new AppException({ code: ErrorCodes.invalidRequest, msg: '回复正文不能超过 2000 个字符' })
  }
  return text
}

const QUESTION_GROUP_LIMIT = 4
const OPTIONS_PER_QUESTION = 3

export function requireCreativeDecision(interaction: SceneGenerationReplyInteraction): void {
  if (interaction.kind !== 'decision') return
  const questions = interaction.questions
  if (questions !== undefined) {
    if (interaction.options.length !== 0) {
      throw new AppException({ code: ErrorCodes.invalidRequest, msg: '问题组不能同时携带单题选项' })
    }
    if (questions.length < 1 || questions.length > QUESTION_GROUP_LIMIT) {
      throw new AppException({ code: ErrorCodes.invalidRequest, msg: '创作提问必须是 1 到 4 题' })
    }
    const questionIds = new Set<string>()
    for (const question of questions) {
      const questionId = requireText(question.questionId, '创作提问标识不能为空')
      if (questionIds.has(questionId)) {
        throw new AppException({ code: ErrorCodes.invalidRequest, msg: '创作提问标识不能重复' })
      }
      questionIds.add(questionId)
      requireText(question.prompt, '创作提问不能为空')
      requireQuestionOptions(question.options)
    }
    return
  }
  if (interaction.options.length !== OPTIONS_PER_QUESTION) {
    throw new AppException({ code: ErrorCodes.invalidRequest, msg: '创作决策必须恰好有三个选项' })
  }
  requireQuestionOptions(interaction.options)
}

function requireQuestionOptions(options: readonly SceneGenerationReplyOption[]): void {
  if (options.length !== OPTIONS_PER_QUESTION) {
    throw new AppException({ code: ErrorCodes.invalidRequest, msg: '每题必须恰好有三个选项' })
  }
  const ids = new Set<string>()
  for (const option of options) {
    const id = requireText(option.id, '创作决策选项标识不能为空')
    if (ids.has(id)) {
      throw new AppException({ code: ErrorCodes.invalidRequest, msg: '创作决策选项标识不能重复' })
    }
    ids.add(id)
    requireText(option.label, '创作决策选项标题不能为空')
    requireText(option.description, '创作决策选项说明不能为空')
  }
}

export function requireCandidateReview(
  execution: Pick<SceneGenerationReplyExecution, 'candidateSnapshotId'>,
  interaction: SceneGenerationReplyInteraction,
  reply: SceneGenerationReply
): void {
  if (interaction.kind !== 'review') return
  if (!(reply.kind in REVIEW_REPLIES)) {
    throw new AppException({
      code: ErrorCodes.invalidRequest,
      msg: '候选审阅只允许接受、提出修改或丢弃'
    })
  }
  if (reply.kind !== 'accept') return
  if (
    !execution.candidateSnapshotId ||
    interaction.candidateSnapshotId !== execution.candidateSnapshotId
  ) {
    throw new AppException({
      code: ErrorCodes.operationConflict,
      msg: interaction.candidateSnapshotId
        ? '候选内容已变化，请重新审阅'
        : '接受候选必须绑定当前候选修订'
    })
  }
}

function requireCurrentIdentity(
  execution: SceneGenerationReplyExecution,
  request: SceneGenerationReplyRequest
): SceneGenerationReplyInteraction {
  const interaction = execution.interaction
  const sameScope =
    execution.projectId === request.projectId &&
    execution.sceneId === request.sceneId &&
    execution.operationId === request.operationId &&
    execution.threadId === request.threadId &&
    execution.branchId === request.branchId
  const sameWait =
    interaction?.interactionId === request.interactionId &&
    interaction.checkpointId === request.checkpointId &&
    execution.checkpointId === request.checkpointId
  if (execution.state !== 'waiting' || !sameScope || !sameWait) {
    throw new AppException({
      code: ErrorCodes.operationConflict,
      msg: '该人工等待已结束、已回复或已过期'
    })
  }
  if (interaction.kind === 'decision' && execution.candidateSnapshotId) {
    throw new AppException({
      code: ErrorCodes.operationConflict,
      msg: '候选已存在，旧题组已失效，请按候选继续修改或重新生成'
    })
  }
  if (execution.replies.some((reply) => reply.replyId === request.replyId)) {
    throw new AppException({
      code: ErrorCodes.operationConflict,
      msg: '该回复已经接受，不能重复提交'
    })
  }
  if (
    (interaction.candidateSnapshotId ?? undefined) !== (request.candidateSnapshotId ?? undefined)
  ) {
    throw new AppException({
      code: ErrorCodes.operationConflict,
      msg: '候选内容已变化，请重新审阅'
    })
  }
  return interaction
}

function selectionFact(
  interaction: SceneGenerationReplyInteraction,
  reply: SceneGenerationReply
): SceneGenerationSelectionFact | undefined {
  if (reply.kind !== 'select') return undefined
  const option = interaction.options.find((item) => item.id === reply.optionId)
  if (!option) {
    throw new AppException({ code: ErrorCodes.invalidRequest, msg: '回复选项不属于当前问题' })
  }
  const description = option.description?.trim() ?? ''
  if (interaction.kind === 'decision' && description === '') {
    throw new AppException({ code: ErrorCodes.invalidRequest, msg: '创作决策选项说明不能为空' })
  }
  const body = optionalBody(reply.body)
  return {
    optionId: option.id,
    label: option.label,
    description,
    ...(body === undefined ? {} : { body })
  }
}

function answerFacts(
  interaction: SceneGenerationReplyInteraction,
  reply: SceneGenerationReply
): readonly SceneGenerationAnswerFact[] | undefined {
  if (reply.kind !== 'answers') return undefined
  const questions = interaction.questions ?? []
  if (questions.length === 0) {
    throw new AppException({ code: ErrorCodes.invalidRequest, msg: '当前没有可回答的创作提问' })
  }
  const seen = new Set<string>()
  const byQuestion = new Map<string, (typeof reply.answers)[number]>()
  for (const answer of reply.answers) {
    const questionId = answer.questionId.trim()
    if (questionId === '' || seen.has(questionId)) {
      throw new AppException({ code: ErrorCodes.invalidRequest, msg: '创作回答不能缺题或重复' })
    }
    seen.add(questionId)
    byQuestion.set(questionId, answer)
  }
  if (byQuestion.size !== questions.length) {
    throw new AppException({ code: ErrorCodes.operationConflict, msg: '创作回答与当前提问不一致' })
  }
  return questions.map((question) => {
    const answer = byQuestion.get(question.questionId)
    if (!answer) {
      throw new AppException({
        code: ErrorCodes.operationConflict,
        msg: '创作回答与当前提问不一致'
      })
    }
    const option = question.options.find((item) => item.id === answer.optionId)
    if (!option) {
      throw new AppException({ code: ErrorCodes.invalidRequest, msg: '回复选项不属于当前问题' })
    }
    const body = optionalBody(answer.body)
    return {
      questionId: question.questionId,
      prompt: question.prompt.trim(),
      optionId: option.id,
      label: option.label.trim(),
      description: option.description?.trim() ?? '',
      ...(body === undefined ? {} : { body })
    }
  })
}

/**
 * 校验人工回复仍属于当前操作、线程、分支、交互、检查点和候选。
 * @param checkpoint - 当前检查点的回复资格。缺失或不可回复时拒绝，但不因此冒充可续跑。
 * @returns 选择回复的业务事实；其他回复没有该事实。
 * @throws {AppException} 身份过期、回复重复、动作非法、正文非法或检查点不能回复。
 */
export function validateSceneGenerationReply(
  execution: SceneGenerationReplyExecution,
  request: SceneGenerationReplyRequest,
  checkpoint?: SceneGenerationReplyCheckpoint
): SceneGenerationSelectionFact | readonly SceneGenerationAnswerFact[] | undefined {
  const interaction = requireCurrentIdentity(execution, request)
  requireCreativeDecision(interaction)
  if (!interaction.allowedReplies.includes(request.reply.kind)) {
    throw new AppException({ code: ErrorCodes.invalidRequest, msg: '该问题不允许此类回复' })
  }
  requireCandidateReview(execution, interaction, request.reply)
  if (request.reply.kind === 'clarify' || request.reply.kind === 'revise') {
    if (optionalBody(request.reply.body) === undefined) {
      throw new AppException({ code: ErrorCodes.invalidRequest, msg: '回复正文不能为空' })
    }
  }
  if (request.reply.kind === 'select') optionalBody(request.reply.body)
  const checkpointMatches =
    checkpoint?.canReply === true &&
    checkpoint.checkpointId === request.checkpointId &&
    checkpoint.operationId === execution.operationId &&
    checkpoint.threadId === execution.threadId &&
    checkpoint.branchId === execution.branchId
  if (!checkpointMatches) {
    throw new AppException({ code: ErrorCodes.operationConflict, msg: '当前等待缺少可靠回复依据' })
  }
  return selectionFact(interaction, request.reply) ?? answerFacts(interaction, request.reply)
}

const UNSAFE_INTERRUPT: Record<'candidateConflict' | 'commitUnknown' | 'writeUnknown', true> = {
  candidateConflict: true,
  commitUnknown: true,
  writeUnknown: true
}

export function canRequestSceneGenerationPause(execution: SceneGenerationReplyExecution): boolean {
  if (execution.interruptReason !== undefined && execution.interruptReason in UNSAFE_INTERRUPT) {
    return false
  }
  // 等待态没有正在运行的工作流可撤销写资格；暂停只适用于活动执行。
  return execution.state === 'pending' || execution.state === 'running'
}

export function canResumePausedSceneGeneration(
  execution: SceneGenerationReplyExecution,
  checkpoint?: SceneGenerationReplyCheckpoint
): boolean {
  return (
    execution.state === 'interrupted' &&
    execution.interruptReason === 'paused' &&
    execution.checkpointId !== undefined &&
    checkpoint?.canContinue === true &&
    checkpoint.checkpointId === execution.checkpointId &&
    checkpoint.operationId === execution.operationId &&
    checkpoint.threadId === execution.threadId &&
    checkpoint.branchId === execution.branchId &&
    (checkpoint.candidateSnapshotId ?? undefined) === (execution.candidateSnapshotId ?? undefined)
  )
}

export function canResumeInterruptedSceneGeneration(
  execution: SceneGenerationReplyExecution,
  checkpoint?: SceneGenerationReplyCheckpoint
): boolean {
  if (
    execution.state === 'failed' ||
    execution.state === 'cancelled' ||
    execution.state === 'succeeded' ||
    execution.state === 'cancelling'
  ) {
    return false
  }
  if (execution.interruptReason !== undefined && execution.interruptReason in UNSAFE_INTERRUPT) {
    return false
  }
  const resumable =
    execution.state === 'interrupted' ||
    execution.state === 'pending' ||
    execution.state === 'running' ||
    execution.state === 'waiting'
  return (
    resumable &&
    execution.checkpointId !== undefined &&
    checkpoint?.canContinue === true &&
    checkpoint.checkpointId === execution.checkpointId &&
    checkpoint.operationId === execution.operationId &&
    checkpoint.threadId === execution.threadId &&
    checkpoint.branchId === execution.branchId &&
    (checkpoint.candidateSnapshotId ?? undefined) === (execution.candidateSnapshotId ?? undefined)
  )
}

export function canRetryFailedSceneGenerationRepair(
  source: {
    readonly projectId: string
    readonly sceneId: string
    readonly operationId: string
    readonly threadId: string
    readonly branchId: string
    readonly state: string
    readonly checkpointId?: string
    readonly candidateSnapshotId?: string
    readonly replies: readonly {
      readonly reply: { readonly kind: string; readonly body?: string }
    }[]
    readonly repairContext?: { readonly instruction: string }
  },
  request: {
    readonly projectId: string
    readonly sceneId: string
    readonly sourceOperationId: string
    readonly sourceThreadId: string
    readonly sourceBranchId: string
    readonly sourceCheckpointId: string
    readonly candidateSnapshotId: string
    readonly instruction: string
  }
): boolean {
  if (source.state !== 'failed') return false
  if (
    source.projectId !== request.projectId ||
    source.sceneId !== request.sceneId ||
    source.operationId !== request.sourceOperationId ||
    source.threadId !== request.sourceThreadId ||
    source.branchId !== request.sourceBranchId ||
    source.checkpointId !== request.sourceCheckpointId ||
    source.candidateSnapshotId !== request.candidateSnapshotId
  ) {
    return false
  }
  const instruction = request.instruction.trim()
  if (instruction === '' || [...instruction].length > SCENE_GENERATION_REPLY_BODY_LIMIT) {
    return false
  }
  const fromReply = source.replies.some(
    (reply) => reply.reply.kind === 'revise' && reply.reply.body?.trim() === instruction
  )
  const fromContext = source.repairContext?.instruction.trim() === instruction
  return fromReply || fromContext
}

export function canPreviewPublishedCandidate(
  request: PublishedSceneGenerationCandidate,
  published: readonly PublishedSceneGenerationCandidate[]
): boolean {
  return published.some(
    (candidate) =>
      candidate.operationId === request.operationId &&
      candidate.threadId === request.threadId &&
      candidate.branchId === request.branchId &&
      candidate.checkpointId === request.checkpointId &&
      candidate.candidateSnapshotId === request.candidateSnapshotId
  )
}
