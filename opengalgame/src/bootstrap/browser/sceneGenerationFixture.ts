import type {
  ListSceneGenerationHistoryForSceneDTO,
  ReadSceneGenerationCheckpointDTO,
  ReplySceneGenerationInteractionDTO,
  ResumeSceneGenerationDTO,
  RetrySceneGenerationRepairDTO,
  SceneGenerationScopeDTO,
  StartSceneGenerationDTO
} from '@application/scene-generation/dto/SceneGenerationDTO'
import type {
  SceneGenerationHistoryBoundary,
  SceneGenerationHistorySummaryVO,
  SceneGenerationRenderInteractionVO,
  SceneGenerationRenderStage,
  SceneGenerationRenderStatusVO
} from '@application/scene-generation/vo/SceneGenerationRenderVO'
import type { AjaxResult } from '@common/contracts/AjaxResult'
import { ErrorCodes } from '@common/errors/ErrorCodes'

export type GenerationFixtureScenario =
  | 'idle'
  | 'startFailure'
  | 'runFailure'
  | 'runLegacyFailure'
  | 'runCommitUnknown'
  | 'runCandidateConflict'
  | 'running'
  | 'decision'
  | 'questions'
  | 'questionsSingle'
  | 'questionsFailure'
  | 'questionsNext'
  | 'questionsFollowup'
  | 'questionsAnswered'
  | 'clarification'
  | 'correction'
  | 'review'
  | 'paused'
  | 'cancelling'
  | 'completed'
  | 'failed'
  | 'legacyFailure'
  | 'commitUnknown'
  | 'candidateConflict'
  | 'cancelled'
  | 'historyRecords'
  | 'historyEmpty'
  | 'historyLoading'
  | 'historyError'

export interface SceneGenerationFixture {
  start(request: StartSceneGenerationDTO): AjaxResult<SceneGenerationRenderStatusVO>
  retryRepair(request: RetrySceneGenerationRepairDTO): AjaxResult<SceneGenerationRenderStatusVO>
  status(request: SceneGenerationScopeDTO): AjaxResult<SceneGenerationRenderStatusVO>
  reply(request: ReplySceneGenerationInteractionDTO): AjaxResult<SceneGenerationRenderStatusVO>
  pause(request: SceneGenerationScopeDTO): AjaxResult<SceneGenerationRenderStatusVO>
  resume(request: ResumeSceneGenerationDTO): AjaxResult<SceneGenerationRenderStatusVO>
  cancel(request: SceneGenerationScopeDTO): AjaxResult<SceneGenerationRenderStatusVO>
  listHistory(
    request: ListSceneGenerationHistoryForSceneDTO
  ):
    | AjaxResult<readonly SceneGenerationHistorySummaryVO[]>
    | Promise<AjaxResult<readonly SceneGenerationHistorySummaryVO[]>>
  readCheckpoint(
    request: ReadSceneGenerationCheckpointDTO
  ): AjaxResult<SceneGenerationHistorySummaryVO>
}

const stageMessage: Record<SceneGenerationRenderStage, string> = {
  readingInput: '正在读取已保存编排与输入',
  generating: 'AI 正在生成候选脚本',
  validating: '正在校验候选脚本或按校验结果修正',
  waitingReview: '候选已就绪，等待你的决定',
  committing: '正在提交作品',
  completed: '作品已提交',
  failed: '本次生成未完成',
  cancelled: '本次生成已取消',
  paused: '已暂停，可继续'
}

const decisionInteraction: SceneGenerationRenderInteractionVO = {
  interactionId: 'fixture-interaction-decision',
  checkpointId: 'fixture-checkpoint',
  kind: 'decision',
  question: '旧友身份要在这里挑明吗？',
  detail: '人物设定要求先隐藏身份，场景目标希望两人当场相认。',
  message: '初稿已经完成，有一个创作冲突需要你决定。',
  options: [
    { id: 'reveal', label: '现在挑明', description: '让两人在站台当场相认' },
    { id: 'hide', label: '继续隐藏', description: '把相认留到下一场' }
  ],
  allowedReplies: ['select']
}

function fixtureOptions(
  questionId: string,
  labels: readonly [string, string, string]
): { id: string; label: string; description: string }[] {
  return labels.map((label, index) => ({
    id: `${questionId}-option-${index + 1}`,
    label,
    description: `${label}的说明`
  }))
}

const fourQuestionInteraction: SceneGenerationRenderInteractionVO = {
  interactionId: 'fixture-interaction-questions',
  checkpointId: 'fixture-checkpoint',
  kind: 'decision',
  message: '这一场有四个创作决定，答完后继续生成。',
  options: [],
  questions: [
    {
      questionId: 'q1',
      prompt: '两人在站台要不要相认？',
      detail: '人物设定要求先隐藏身份。',
      options: fixtureOptions('q1', ['当场相认', '继续隐藏', '只交换眼神'])
    },
    {
      questionId: 'q2',
      prompt: '雨声停在什么时候？',
      options: fixtureOptions('q2', ['对白开始时', '离开站台时', '贯穿整场'])
    },
    {
      questionId: 'q3',
      prompt: '末班车的广播怎么处理？',
      options: fixtureOptions('q3', ['完整播报', '只留远处声音', '不使用广播'])
    },
    {
      questionId: 'q4',
      prompt: '告别后角色先做什么？',
      options: fixtureOptions('q4', ['回头看伞', '直接上车', '在站台停留'])
    }
  ],
  allowedReplies: ['answers', 'discard']
}

const singleQuestionInteraction: SceneGenerationRenderInteractionVO = {
  ...fourQuestionInteraction,
  interactionId: 'fixture-interaction-question',
  message: '这一场有一个创作决定，确认后继续生成。',
  questions: fourQuestionInteraction.questions?.slice(0, 1)
}

const followupQuestionInteraction: SceneGenerationRenderInteractionVO = {
  interactionId: 'fixture-interaction-question-2',
  checkpointId: 'fixture-checkpoint',
  kind: 'decision',
  message: '上一题已经记下。这一场还有一个新的创作决定。',
  options: [],
  questions: [
    {
      questionId: 'q2',
      prompt: '雨停之后先写什么？',
      detail: '不要沿用上一题的选项。',
      options: fixtureOptions('q2', ['写脚步', '写广播', '写沉默'])
    }
  ],
  allowedReplies: ['answers', 'discard']
}
const clarificationInteraction: SceneGenerationRenderInteractionVO = {
  interactionId: 'fixture-interaction-clarification',
  checkpointId: 'fixture-checkpoint',
  kind: 'clarification',
  question: '这一幕的雨要一直下吗？',
  message: '候选已经写出，但雨声的时长需要你补充。',
  options: [
    { id: 'stop', label: '雨停', description: '对白开始时收掉雨声' },
    { id: 'keep', label: '继续下雨', description: '雨声贯穿整场' }
  ],
  allowedReplies: ['select', 'clarify']
}

const correctionInteraction: SceneGenerationRenderInteractionVO = {
  interactionId: 'fixture-interaction-correction',
  checkpointId: 'fixture-checkpoint',
  kind: 'correction',
  message: '上一版候选有两处对白冲突，需要你指认保留哪一版。',
  detail: '按你的修改重新写一遍，然后再次等你审阅。',
  options: [],
  allowedReplies: ['revise', 'discard']
}

const reviewInteraction: SceneGenerationRenderInteractionVO = {
  interactionId: 'fixture-interaction-review',
  checkpointId: 'fixture-checkpoint',
  kind: 'review',
  message: '候选已生成，等你审阅。',
  options: [],
  allowedReplies: ['accept', 'revise', 'discard'],
  candidateSnapshotId: 'fixture-candidate'
}

const inputSummary = {
  canvasId: 'canvas-1',
  arrangementVersion: 'fixture-v1',
  documentCount: 2,
  assetCount: 3,
  promptCount: 1,
  fieldBindingCount: 2,
  relationCount: 2,
  confirmedControlCount: 0
} as const

const fixtureRecentProgress = [
  {
    sequence: 1,
    createdAt: new Date(2026, 9, 21, 10, 24, 0).toISOString(),
    stage: 'readingInput' as const,
    message: stageMessage.readingInput
  },
  {
    sequence: 2,
    createdAt: new Date(2026, 9, 21, 10, 24, 20).toISOString(),
    stage: 'generating' as const,
    message: stageMessage.generating
  },
  {
    sequence: 3,
    createdAt: new Date(2026, 9, 21, 10, 24, 40).toISOString(),
    stage: 'validating' as const,
    message: stageMessage.validating
  },
  {
    sequence: 4,
    createdAt: new Date(2026, 9, 21, 10, 25, 0).toISOString(),
    stage: 'generating' as const,
    message: '等待模型响应（连接较慢时可继续等待或取消）'
  },
  {
    sequence: 5,
    createdAt: new Date(2026, 9, 21, 10, 25, 20).toISOString(),
    stage: 'validating' as const,
    message: stageMessage.validating
  },
  {
    sequence: 6,
    createdAt: new Date(2026, 9, 21, 10, 25, 40).toISOString(),
    stage: 'waitingReview' as const,
    message: stageMessage.waitingReview
  }
]

function baseStatus(identity: {
  projectId: string
  sceneId: string
}): SceneGenerationRenderStatusVO {
  return {
    projectId: identity.projectId,
    sceneId: identity.sceneId,
    operationId: 'fixture-operation',
    threadId: 'fixture-thread',
    branchId: 'fixture-branch',
    state: 'running',
    stage: 'generating',
    stageMessage: stageMessage.generating,
    attempt: 0,
    sequence: 3,
    checkpointId: 'fixture-checkpoint',
    canPause: true,
    canResume: false,
    canCancel: true,
    inputSummary,
    usage: { inputTokens: 3240, outputTokens: 4860, totalTokens: 8100, tokenLimit: null },
    recentProgress: fixtureRecentProgress,
    previewAvailable: false
  }
}

function statusOf(
  scenario: GenerationFixtureScenario,
  identity: { projectId: string; sceneId: string }
): SceneGenerationRenderStatusVO {
  const base = baseStatus(identity)
  switch (scenario) {
    case 'decision':
      return {
        ...base,
        state: 'waiting',
        stage: 'waitingReview',
        stageMessage: stageMessage.waitingReview,
        canPause: false,
        interaction: decisionInteraction
      }
    case 'questions':
    case 'questionsFailure':
      return {
        ...base,
        state: 'waiting',
        stage: 'waitingReview',
        stageMessage: stageMessage.waitingReview,
        canPause: false,
        interaction: fourQuestionInteraction
      }
    case 'questionsSingle':
    case 'questionsNext':
      return {
        ...base,
        state: 'waiting',
        stage: 'waitingReview',
        stageMessage: stageMessage.waitingReview,
        canPause: false,
        interaction: singleQuestionInteraction
      }
    case 'questionsFollowup':
      return {
        ...base,
        state: 'waiting',
        stage: 'waitingReview',
        stageMessage: stageMessage.waitingReview,
        canPause: false,
        interaction: followupQuestionInteraction
      }
    case 'questionsAnswered':
      return {
        ...base,
        state: 'running',
        stage: 'generating',
        stageMessage: stageMessage.generating,
        answeredQuestions: [
          {
            questionId: 'q1',
            prompt: '两人在站台要不要相认？',
            optionId: 'q1-option-2',
            label: '继续隐藏',
            description: '继续隐藏的说明',
            body: '留到下一场再相认'
          }
        ]
      }
    case 'clarification':
      return {
        ...base,
        state: 'waiting',
        stage: 'waitingReview',
        stageMessage: stageMessage.waitingReview,
        canPause: false,
        interaction: clarificationInteraction
      }
    case 'correction':
      return {
        ...base,
        state: 'waiting',
        stage: 'waitingReview',
        stageMessage: stageMessage.waitingReview,
        canPause: false,
        interaction: correctionInteraction
      }
    case 'review':
      return {
        ...base,
        state: 'waiting',
        stage: 'waitingReview',
        stageMessage: stageMessage.waitingReview,
        canPause: false,
        candidateSnapshotId: 'fixture-candidate',
        previewAvailable: true,
        interaction: reviewInteraction
      }
    case 'paused':
      return {
        ...base,
        state: 'interrupted',
        stage: 'paused',
        stageMessage: stageMessage.paused,
        canPause: false,
        canResume: true
      }
    case 'cancelling':
      return {
        ...base,
        state: 'cancelling',
        stage: 'generating',
        stageMessage: '正在取消这次生成',
        canPause: false,
        canCancel: false
      }
    case 'completed':
      return {
        ...base,
        state: 'succeeded',
        stage: 'completed',
        stageMessage: stageMessage.completed,
        canPause: false,
        canCancel: false,
        result: { commitId: 'fixture-commit' }
      }
    case 'failed':
      return {
        ...base,
        state: 'failed',
        stage: 'failed',
        stageMessage: stageMessage.failed,
        canPause: false,
        canCancel: false,
        candidateSnapshotId: 'fixture-candidate',
        failure: {
          code: ErrorCodes.operationConflict,
          message: '模型调用失败，本次生成未完成',
          reason: 'modelFailure',
          failureClass: 'modelTransient',
          nextActions: ['retryOperation', 'viewCandidate'],
          reference: '4f9c2a71d8e6',
          unverified: false
        }
      }
    case 'legacyFailure': {
      // 旧记录没有执行时间线，最近安全进度保持缺失，不能从基础夹具继承。
      const legacyBase = { ...base }
      delete legacyBase.recentProgress
      return {
        ...legacyBase,
        state: 'failed',
        stage: 'failed',
        stageMessage: stageMessage.failed,
        canPause: false,
        canCancel: false,
        failure: {
          code: ErrorCodes.operationConflict,
          message: '模型连接中断，本次生成未完成。',
          unverified: false,
          legacy: true
        }
      }
    }
    case 'commitUnknown':
      return {
        ...base,
        state: 'failed',
        stage: 'failed',
        stageMessage: stageMessage.failed,
        canPause: false,
        canCancel: false,
        failure: {
          code: ErrorCodes.operationConflict,
          message: '提交结果待核对',
          reference: 'c0a17b93e52d',
          unverified: true
        }
      }
    case 'candidateConflict':
      return {
        ...base,
        state: 'failed',
        stage: 'failed',
        stageMessage: stageMessage.failed,
        canPause: false,
        canCancel: false,
        failure: {
          code: ErrorCodes.operationConflict,
          message: '候选或基线冲突，需要重新核对',
          unverified: false
        }
      }
    case 'cancelled':
      return {
        ...base,
        state: 'cancelled',
        stage: 'cancelled',
        stageMessage: stageMessage.cancelled,
        canPause: false,
        canCancel: false
      }
    case 'historyRecords':
    case 'historyEmpty':
    case 'historyLoading':
    case 'historyError':
      // 历史走查场景没有活动任务：最近一次记录已终态，页面不会采纳为进行中的生成。
      return {
        ...base,
        state: 'succeeded',
        stage: 'completed',
        stageMessage: stageMessage.completed,
        canPause: false,
        canCancel: false
      }
    default:
      return base
  }
}

function boundaryOf(scenario: GenerationFixtureScenario): SceneGenerationHistoryBoundary {
  if (scenario === 'completed') return 'committed'
  if (
    scenario === 'failed' ||
    scenario === 'legacyFailure' ||
    scenario === 'commitUnknown' ||
    scenario === 'candidateConflict'
  ) {
    return 'failed'
  }
  if (scenario === 'cancelled') return 'cancelled'
  if (scenario === 'paused') return 'paused'
  if (scenario === 'review') return 'waitingReview'
  if (scenario === 'decision') return 'waitingDecision'
  return 'started'
}

function historyOf(
  scenario: GenerationFixtureScenario,
  identity: { projectId: string; sceneId: string }
): SceneGenerationHistorySummaryVO {
  const status = statusOf(scenario, identity)
  return {
    projectId: status.projectId,
    sceneId: status.sceneId,
    operationId: status.operationId,
    threadId: status.threadId,
    branchId: status.branchId,
    checkpointId: 'fixture-checkpoint',
    boundary: boundaryOf(scenario),
    stage: status.stage,
    message: status.stageMessage,
    createdAt: new Date(2026, 9, 21, 10, 24).toISOString(),
    ...(status.candidateSnapshotId ? { candidateSnapshotId: status.candidateSnapshotId } : {}),
    ...(status.result ? { commitId: status.result.commitId } : {}),
    ...(boundaryOf(scenario) === 'failed' && status.failure?.reason
      ? { failureReason: status.failure.reason }
      : {}),
    ...(status.failure?.legacy === true ? { legacy: true } : {})
  }
}

const historyBoundaryOrder: readonly SceneGenerationHistoryBoundary[] = [
  'committed',
  'waitingReview',
  'candidateCreated',
  'started',
  'failed',
  'paused',
  'cancelled',
  'waitingDecision'
]

const historyBoundaryStages: Record<SceneGenerationHistoryBoundary, SceneGenerationRenderStage> = {
  started: 'generating',
  candidateCreated: 'validating',
  waitingDecision: 'waitingReview',
  waitingReview: 'waitingReview',
  paused: 'paused',
  committed: 'completed',
  failed: 'failed',
  cancelled: 'cancelled'
}

const historyBoundaryMessages: Record<SceneGenerationHistoryBoundary, string> = {
  started: '开始生成这一场，读取已保存的编排。',
  candidateCreated: '已生成第一版候选，等待校验。',
  waitingDecision: '有一个创作冲突需要你决定。',
  waitingReview: '候选已生成，等你审阅。',
  paused: '生成已暂停，输入和候选保持不变。',
  committed: '作品已提交，可以到作品历史查看。',
  failed: '候选与当前基线冲突，本次生成没有完成。',
  cancelled: '本次生成已取消，没有写入作品。'
}

const historyRecordCount = 43
const historyRecordIntervalMs = 37 * 60 * 1000
const historyRecordAnchor = new Date(2026, 9, 21, 18, 40).getTime()

/** 只读历史替身：43 条固定摘要，支持 checkpointId 游标和三页读取。 */
function sceneHistoryRecords(identity: {
  projectId: string
  sceneId: string
}): readonly SceneGenerationHistorySummaryVO[] {
  return Array.from({ length: historyRecordCount }, (_, index) => {
    const boundary = historyBoundaryOrder[index % historyBoundaryOrder.length]
    return {
      projectId: identity.projectId,
      sceneId: identity.sceneId,
      operationId: `fixture-history-operation-${index + 1}`,
      threadId: `fixture-history-thread-${index + 1}`,
      branchId: `fixture-history-branch-${index + 1}`,
      checkpointId: `fixture-history-checkpoint-${index + 1}`,
      boundary,
      stage: historyBoundaryStages[boundary],
      message: historyBoundaryMessages[boundary],
      createdAt: new Date(historyRecordAnchor - index * historyRecordIntervalMs).toISOString(),
      ...(boundary === 'failed' ? { failureReason: 'modelFailure' as const } : {})
    }
  })
}

function historyPage(
  records: readonly SceneGenerationHistorySummaryVO[],
  cursor: string | undefined,
  limit: number
): readonly SceneGenerationHistorySummaryVO[] {
  let start = 0
  if (cursor !== undefined) {
    const index = records.findIndex((record) => record.checkpointId === cursor)
    if (index < 0) return []
    start = index + 1
  }
  return records.slice(start, start + limit)
}

function historyRecordsForScenario(
  scenario: GenerationFixtureScenario,
  identity: { projectId: string; sceneId: string }
): readonly SceneGenerationHistorySummaryVO[] {
  if (
    scenario === 'idle' ||
    scenario === 'startFailure' ||
    scenario === 'runFailure' ||
    scenario === 'runLegacyFailure' ||
    scenario === 'runCommitUnknown' ||
    scenario === 'runCandidateConflict' ||
    scenario === 'historyEmpty'
  ) {
    return []
  }
  if (scenario === 'historyRecords' || scenario === 'historyLoading') {
    return sceneHistoryRecords(identity)
  }
  if (scenario === 'historyError') return sceneHistoryRecords(identity).slice(0, 1)
  return [historyOf(scenario, identity)]
}

const success = <T>(msg: string, data: T): AjaxResult<T> => ({
  code: ErrorCodes.success,
  msg,
  data
})

/**
 * 浏览器走查用的生成夹具。只在没有桌面桥且 URL 带 `generation` 参数时启用，
 * 用固定安全 VO 走查空态、等待、审阅、暂停、失败和完成；不代表真实生成成功。
 * `historyRecords` / `historyEmpty` / `historyLoading` / `historyError` 只提供
 * AI 历史的只读替身（43 条固定摘要），不是真实生成记录，也不会写入作品。
 */
export function createSceneGenerationFixture(value: string | null): SceneGenerationFixture | null {
  const known: readonly GenerationFixtureScenario[] = [
    'idle',
    'startFailure',
    'runFailure',
    'runLegacyFailure',
    'runCommitUnknown',
    'runCandidateConflict',
    'running',
    'decision',
    'questions',
    'questionsSingle',
    'questionsNext',
    'questionsFailure',
    'questionsAnswered',
    'clarification',
    'correction',
    'review',
    'paused',
    'cancelling',
    'completed',
    'failed',
    'legacyFailure',
    'commitUnknown',
    'candidateConflict',
    'cancelled',
    'historyRecords',
    'historyEmpty',
    'historyLoading',
    'historyError'
  ]
  const initial = known.find((scenario) => scenario === value)
  if (!initial) return null
  let current: GenerationFixtureScenario = initial
  let identity = { projectId: 'p-01', sceneId: 'scene-1' }
  let sequence = statusOf(initial, identity).sequence
  let recordedAnswers: SceneGenerationRenderStatusVO['answeredQuestions']

  const adopt = (scope: { projectId: string; sceneId: string }): void => {
    identity = { projectId: scope.projectId, sceneId: scope.sceneId }
  }

  const advance = (next: GenerationFixtureScenario): SceneGenerationRenderStatusVO => {
    current = next
    sequence += 1
    return { ...statusOf(next, identity), sequence }
  }

  const expectScope = (scope: SceneGenerationScopeDTO): AjaxResult<never> | null =>
    scope.operationId === 'fixture-operation' ||
    scope.operationId.startsWith('fixture-history-operation-')
      ? null
      : { code: ErrorCodes.invalidRequest, msg: '夹具里没有这个生成操作' }

  return {
    start(request) {
      adopt(request)
      if (initial === 'startFailure') {
        return {
          code: ErrorCodes.invalidConfig,
          msg: '当前没有可用的模型连接，生成没有启动。'
        }
      }
      if (initial === 'runFailure') return success('场景生成已启动', advance('failed'))
      if (initial === 'runLegacyFailure') return success('场景生成已启动', advance('legacyFailure'))
      if (initial === 'runCommitUnknown') return success('场景生成已启动', advance('commitUnknown'))
      if (initial === 'runCandidateConflict')
        return success('场景生成已启动', advance('candidateConflict'))
      return success('场景生成已启动', advance('running'))
    },
    retryRepair(request) {
      adopt(request)
      if (request.repair.instruction.trim() === '') {
        return { code: ErrorCodes.invalidRequest, msg: '修改正文不能为空' }
      }
      if (
        (request.repair.sourceOperationId !== 'fixture-operation' &&
          !request.repair.sourceOperationId.startsWith('fixture-history-operation-')) ||
        request.repair.sourceThreadId !== 'fixture-thread' ||
        request.repair.sourceBranchId !== 'fixture-branch' ||
        request.repair.sourceCheckpointId !== 'fixture-checkpoint' ||
        request.repair.candidateSnapshotId !== 'fixture-candidate'
      ) {
        return { code: ErrorCodes.invalidRequest, msg: '来源修复身份已过期' }
      }
      if (statusOf(current, identity).state !== 'failed') {
        return { code: ErrorCodes.operationConflict, msg: '来源修复不能重跑，已保留原失败记录' }
      }
      return success('修复重跑已启动', advance('running'))
    },
    status(request) {
      const invalid = expectScope(request)
      if (invalid) return invalid
      adopt(request)
      const status = { ...statusOf(current, identity), sequence }
      return success(
        '生成状态已读取',
        current === 'questionsFollowup' && recordedAnswers
          ? { ...status, answeredQuestions: recordedAnswers }
          : status
      )
    },
    reply(request) {
      const invalid = expectScope(request)
      if (invalid) return invalid
      const kind = request.reply.kind
      if (current === 'questionsFailure' && kind === 'answers') {
        return { code: ErrorCodes.operationConflict, msg: '这次回答没有保存，请修改后重新提交。' }
      }
      if (current === 'questionsNext' && request.reply.kind === 'answers') {
        recordedAnswers = request.reply.answers.map((answer) => {
          const question = singleQuestionInteraction.questions?.find(
            (item) => item.questionId === answer.questionId
          )
          const option = question?.options.find((item) => item.id === answer.optionId)
          const body = answer.body?.trim()
          return {
            questionId: answer.questionId,
            prompt: question?.prompt ?? answer.questionId,
            optionId: answer.optionId,
            label: option?.label ?? answer.optionId,
            description: option?.description ?? '',
            ...(body ? { body } : {})
          }
        })
        return success('回复已接收', {
          ...advance('questionsFollowup'),
          answeredQuestions: recordedAnswers
        })
      }
      if (kind === 'answers') return success('回复已接收', advance('questionsAnswered'))
      if (kind === 'accept') return success('回复已接收', advance('completed'))
      if (kind === 'discard') return success('回复已接收', advance('cancelled'))
      if (kind === 'revise' || kind === 'clarify' || kind === 'select') {
        return success('回复已接收', advance('running'))
      }
      return { code: ErrorCodes.invalidRequest, msg: '夹具不支持这种回复' }
    },
    pause(request) {
      const invalid = expectScope(request)
      if (invalid) return invalid
      return success('生成已暂停', advance('paused'))
    },
    resume(request) {
      const invalid = expectScope(request)
      if (invalid) return invalid
      if (request.checkpointId !== 'fixture-checkpoint') {
        return { code: ErrorCodes.operationConflict, msg: '恢复身份已过期' }
      }
      return success('生成已继续', advance('running'))
    },
    cancel(request) {
      const invalid = expectScope(request)
      if (invalid) return invalid
      return success('生成已取消', advance('cancelled'))
    },
    listHistory(request) {
      adopt(request)
      const limit = Math.min(Math.max(request.limit, 1), 100)
      if (current === 'historyError' && limit > 1) {
        return {
          code: ErrorCodes.communicationFailed,
          msg: '场景历史暂时读取失败，画布和作品都没有受影响。'
        }
      }
      const records = historyRecordsForScenario(current, identity)
      const page = historyPage(records, request.cursor, limit)
      if (current === 'historyLoading' && limit > 1) {
        return new Promise<AjaxResult<readonly SceneGenerationHistorySummaryVO[]>>((resolve) => {
          setTimeout(() => resolve(success('场景历史已读取', page)), 1400)
        })
      }
      return success('场景历史已读取', page)
    },
    readCheckpoint(request) {
      adopt(request)
      const found = historyRecordsForScenario(current, identity).find(
        (record) => record.checkpointId === request.checkpointId
      )
      return found
        ? success('检查点已读取', found)
        : { code: ErrorCodes.invalidRequest, msg: '夹具里没有这个检查点' }
    }
  }
}
