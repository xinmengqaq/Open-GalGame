import { ErrorCodes } from '@common/errors/ErrorCodes'
import {
  canRequestSceneGenerationPause,
  canResumeInterruptedSceneGeneration,
  canResumePausedSceneGeneration
} from '@domain/scene-generation/services/validateSceneGenerationReply'
import type {
  SceneGenerationExecution,
  SceneGenerationInterruptReason
} from '../models/SceneGenerationExecution'
import type {
  SceneGenerationInputsDTO,
  SceneGenerationPromptScopeDTO
} from '../dto/SceneGenerationDTO'
import {
  failureClassOfLegacyReason,
  NEXT_ACTIONS,
  type FailureClass,
  type NextAction
} from '../models/SceneGenerationRunOutcome'
import type { SceneGenerationInteractionVO } from '../vo/SceneGenerationVO'
import { renderStageOf } from './SceneGenerationStateProjection'
import type {
  SceneGenerationHistoryBoundary,
  SceneGenerationHistorySummaryVO,
  SceneGenerationInputSummaryVO,
  SceneGenerationRecentProgressVO,
  SceneGenerationRenderInteractionVO,
  SceneGenerationRenderProgressEventVO,
  SceneGenerationRenderStage,
  SceneGenerationRenderStatusVO,
  SceneGenerationTimelineEntryVO,
  SceneGenerationUsageVO
} from '../vo/SceneGenerationRenderVO'

const STAGE_MESSAGE: Record<SceneGenerationRenderStage, string> = {
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

const INTERRUPT_MESSAGE: Record<SceneGenerationInterruptReason, string> = {
  paused: '已暂停，可继续',
  candidateConflict: '候选或基线冲突，需要重新核对',
  commitUnknown: '提交结果待核对'
}

/** 内部状态只映射到固定安全文案，不透传模型摘要、工具输出或异常原文。 */
export function renderStage(execution: SceneGenerationExecution): SceneGenerationRenderStage {
  return renderStageOf(execution.state, execution.step, execution.interruptReason)
}

export function renderStageMessage(
  stage: SceneGenerationRenderStage,
  interruptReason?: SceneGenerationInterruptReason,
  activity?: SceneGenerationExecution['live']
): string {
  if (interruptReason === 'candidateConflict' || interruptReason === 'commitUnknown') {
    return INTERRUPT_MESSAGE[interruptReason]
  }
  if (activity?.activity === 'waitingModel' && stage === 'generating') {
    return '等待模型响应（连接较慢时可继续等待或取消）'
  }
  return STAGE_MESSAGE[stage]
}

const INPUT_DETAIL_LIMIT = 12
const INPUT_DETAIL_TITLE_LIMIT = 40
const INPUT_DETAIL_TEXT_LIMIT = 80

/**
 * 明细最多 12 条；溢出时保留前 11 条，把剩余数量压成一条「等 N 项」。
 * 分类为空时返回 undefined，避免旧快照出现空分组。
 */
function clampInputDetails(items: readonly string[]): readonly string[] | undefined {
  if (items.length === 0) return undefined
  if (items.length <= INPUT_DETAIL_LIMIT) return items
  return [
    ...items.slice(0, INPUT_DETAIL_LIMIT - 1),
    `等 ${items.length - (INPUT_DETAIL_LIMIT - 1)} 项`
  ]
}

/** 提示词作用范围只展示分类和数量，不展开卡片身份。 */
function promptScopeText(scope: SceneGenerationPromptScopeDTO): string {
  if (scope.kind === 'scene') return '场景'
  if (scope.kind === 'cards') return `卡片×${scope.cardIds.length}`
  return '关系×1'
}

/**
 * 明细拆成名称和可选说明。重名编号只加在名称上，记录说明保持原样，
 * 例如「本场提示词 1（记录：文档）」或「未命名提示词 2 · 场景」。
 */
type InputDetailParts = { name: string; suffix?: string }

function inputDetailText(parts: InputDetailParts): string {
  return safeDisplayText(`${parts.name}${parts.suffix ?? ''}`, INPUT_DETAIL_TEXT_LIMIT)
}

/**
 * 同一类目内名称相同的条目按输入数组顺序追加序号；唯一名称保持不变。
 * 编号基于可见条目，顺序取画布快照顺序，保证同一快照的输出稳定可复现。
 */
function withDuplicateOrdinals(parts: readonly InputDetailParts[]): InputDetailParts[] {
  const names = new Map<string, number>()
  for (const part of parts) {
    names.set(part.name, (names.get(part.name) ?? 0) + 1)
  }
  const ordinals = new Map<string, number>()
  return parts.map((part) => {
    if ((names.get(part.name) ?? 0) < 2) return part
    const ordinal = (ordinals.get(part.name) ?? 0) + 1
    ordinals.set(part.name, ordinal)
    return { ...part, name: `${part.name} ${ordinal}` }
  })
}

/** 一类明细的统一收口：丢弃空名称、重名编号、拼接说明、套用条数上限。 */
function buildInputDetails(
  partsList: readonly InputDetailParts[]
): readonly string[] | undefined {
  const visible = partsList.filter((parts) => parts.name !== '')
  return clampInputDetails(withDuplicateOrdinals(visible).map(inputDetailText))
}

/**
 * 提示词卡没有标题时适配层会用卡片 id 填充 title；这里只做显示回退，
 * 不展示正文或路径。名称统一回退为「未命名提示词」，重复名称由收口编号。
 */
function promptInputDetailParts(
  prompt: SceneGenerationInputsDTO['prompts'][number]
): InputDetailParts {
  const title = safeDisplayText(prompt.title, INPUT_DETAIL_TITLE_LIMIT)
  const name =
    title === '' || title === safeDisplayText(prompt.id, INPUT_DETAIL_TITLE_LIMIT)
      ? '未命名提示词'
      : title
  const scopes = prompt.scopes.map(promptScopeText).join('、')
  return scopes === '' ? { name } : { name, suffix: ` · ${scopes}` }
}

/** 文档明细只用标题，不补造正文、摘要或路径。 */
function documentInputDetailParts(
  document: SceneGenerationInputsDTO['documents'][number]
): InputDetailParts {
  return { name: safeDisplayText(document.title, INPUT_DETAIL_TITLE_LIMIT) }
}

/**
 * 关系明细沿用画布关系标签语义：优先具体名；没有具体名时用记录名称或记录类型；
 * 有记录时追加记录标记，最后才回退到「未命名关系」。
 */
function relationInputDetailParts(
  relation: SceneGenerationInputsDTO['relations'][number],
  documents: SceneGenerationInputsDTO['documents']
): InputDetailParts {
  const record = relation.record
  const recordSuffix =
    record === null ? '' : `（记录：${record.kind === 'document' ? '文档' : '提示词'}）`
  const specifiedName = safeDisplayText(relation.specificName, INPUT_DETAIL_TITLE_LIMIT)
  if (specifiedName !== '') {
    return recordSuffix === ''
      ? { name: specifiedName }
      : { name: specifiedName, suffix: recordSuffix }
  }
  if (record === null) return { name: '未命名关系' }
  if (record.kind === 'prompt') return { name: '记录：提示词' }
  const title = safeDisplayText(
    documents.find((document) => document.id === record.cardId)?.title,
    INPUT_DETAIL_TITLE_LIMIT
  )
  return title === '' ? { name: '记录：文档' } : { name: title, suffix: '（记录：文档）' }
}

export function inputSummary(execution: SceneGenerationExecution): SceneGenerationInputSummaryVO {
  const inputs = execution.inputSnapshot
  const documents = buildInputDetails(inputs.documents.map(documentInputDetailParts))
  const prompts = buildInputDetails(inputs.prompts.map(promptInputDetailParts))
  const relations = buildInputDetails(
    inputs.relations.map((relation) => relationInputDetailParts(relation, inputs.documents))
  )
  const hasDetails = documents !== undefined || prompts !== undefined || relations !== undefined
  return {
    canvasId: inputs.canvasId,
    arrangementVersion: inputs.arrangementVersion,
    documentCount: inputs.documents.length,
    assetCount: inputs.assets.length,
    promptCount: inputs.prompts.length,
    fieldBindingCount: inputs.fieldBindings.length,
    relationCount: inputs.relations.length,
    confirmedControlCount: inputs.confirmedControls.length,
    ...(hasDetails
      ? {
          details: {
            ...(documents ? { documents } : {}),
            ...(prompts ? { prompts } : {}),
            ...(relations ? { relations } : {})
          }
        }
      : {})
  }
}

/**
 * 只投影已持久化的当前操作累计 Token。缺失时保持零值，不按字符数估算。
 * 上下文窗口不进入本对象。
 */
export function renderUsage(execution: SceneGenerationExecution): SceneGenerationUsageVO {
  return {
    inputTokens: execution.budget.inputTokens ?? 0,
    outputTokens: execution.budget.outputTokens ?? 0,
    totalTokens: execution.budget.totalTokens ?? 0,
    tokenLimit: execution.budget.tokenLimit ?? null,
    modelCalls: execution.budget.modelCallsUsed,
    toolCalls: execution.budget.toolCallsUsed
  }
}

const LIVE_TOOLS: Record<string, true> = {
  listDirectory: true,
  readTextRange: true,
  writeText: true,
  replaceText: true
}

/** 只投影进行中的安全活动。终态和旧记录不带活动。 */
export function renderActivity(
  execution: SceneGenerationExecution
): SceneGenerationRenderStatusVO['activity'] {
  if (
    execution.state === 'succeeded' ||
    execution.state === 'failed' ||
    execution.state === 'cancelled' ||
    !execution.live
  ) {
    return undefined
  }
  const lastToolName =
    execution.live.lastToolName && LIVE_TOOLS[execution.live.lastToolName]
      ? execution.live.lastToolName
      : undefined
  return {
    kind: execution.live.activity,
    lastActivityAt: execution.live.lastActivityAt,
    ...(lastToolName ? { lastToolName } : {}),
    ...(execution.live.noNewInformationStreak === undefined
      ? {}
      : { noNewInformationStreak: execution.live.noNewInformationStreak })
  }
}

const SAFE_TEXT_LIMIT = 2000

/** 展示文本去掉控制字符并限长。不保留路径、原始模型输出或执行记录。 */
function safeDisplayText(value: string | undefined, limit = SAFE_TEXT_LIMIT): string {
  return (value ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim()
    .slice(0, limit)
}

/** 创作决策必须携带说明；问题组携带安全题干和选项；审阅不携带创作选项。 */
export function renderInteraction(
  interaction: SceneGenerationInteractionVO
): SceneGenerationRenderInteractionVO {
  const questions =
    interaction.kind === 'decision'
      ? interaction.questions?.map((question) => ({
          questionId: question.questionId,
          prompt: safeDisplayText(question.prompt, 500),
          ...(question.detail ? { detail: safeDisplayText(question.detail) } : {}),
          options: question.options.map((option) => ({
            id: option.id,
            label: safeDisplayText(option.label, 200),
            description: safeDisplayText(option.description)
          }))
        }))
      : undefined
  return {
    interactionId: interaction.interactionId,
    checkpointId: interaction.checkpointId,
    kind: interaction.kind,
    question: interaction.question ? safeDisplayText(interaction.question, 500) : undefined,
    detail: interaction.detail ? safeDisplayText(interaction.detail) : undefined,
    message: safeDisplayText(interaction.message, 500),
    options:
      interaction.kind === 'decision' && !questions
        ? interaction.options.map((option) => ({
            id: option.id,
            label: safeDisplayText(option.label, 200),
            description: safeDisplayText(option.description)
          }))
        : [],
    ...(questions?.length ? { questions } : {}),
    allowedReplies: interaction.allowedReplies,
    candidateSnapshotId: interaction.candidateSnapshotId
  }
}

/**
 * 已确认的修改和澄清按轮次投影。文本去掉控制字符，不保留路径或模型原文。
 * 新修复重试把原指令放在来源上下文里而不伪造回复：指令最先生效，后续回复顺延轮次，
 * 同文修改去重，最多保留指令加最近 63 条。旧记录没有上下文时保持原投影。
 */
export function renderUserMessages(
  execution: SceneGenerationExecution
): SceneGenerationRenderStatusVO['userMessages'] {
  const instruction =
    execution.repairContext === undefined
      ? undefined
      : safeDisplayText(execution.repairContext.instruction)
  if (!instruction) {
    const messages = execution.replies.flatMap((reply, index) => {
      if (reply.reply.kind !== 'revise' && reply.reply.kind !== 'clarify') return []
      const body = safeDisplayText(reply.reply.body)
      if (!body) return []
      return [{ kind: reply.reply.kind, body, round: index + 1 }]
    })
    return messages.length > 0 ? messages : undefined
  }
  const later = execution.replies.flatMap((reply) => {
    if (reply.reply.kind !== 'revise' && reply.reply.kind !== 'clarify') return []
    const body = safeDisplayText(reply.reply.body)
    if (!body || (reply.reply.kind === 'revise' && body === instruction)) return []
    return [{ kind: reply.reply.kind, body }]
  })
  const messages = [{ kind: 'revise' as const, body: instruction }, ...later.slice(-63)].map(
    (message, index) => ({ ...message, round: index + 1 })
  )
  return messages
}

/** 已接受的问题组按持久化事实重建，不从请求标题或本地草稿补造。 */
export function renderAnsweredQuestions(
  execution: SceneGenerationExecution
): SceneGenerationRenderStatusVO['answeredQuestions'] {
  const answered = execution.replies.flatMap((reply) => reply.selections ?? [])
  if (answered.length === 0) return undefined
  return answered.map((answer) => ({
    questionId: answer.questionId,
    prompt: safeDisplayText(answer.prompt, 500),
    optionId: answer.optionId,
    label: safeDisplayText(answer.label, 200),
    description: safeDisplayText(answer.description),
    ...(answer.body ? { body: safeDisplayText(answer.body) } : {})
  }))
}

const KNOWN_ISSUE_MESSAGE: Record<string, string> = {
  'missing-entry': '场景入口不存在，不能作为单场景成品',
  'unknown-command': '候选含有当前解析器不能识别的命令',
  'unsupported-dialogue': '生成对白必须使用显式 say，旁白必须使用 -clear',
  'invalid-argument': '候选含有当前解析器不能识别的参数',
  'scene-jump': '候选含有不允许的场景跳转',
  'option-edge': '候选含有不允许的选项',
  condition: '候选含有不允许的条件',
  'unauthorized-asset': '候选引用了本次未提供的素材',
  'missing-asset': '候选引用的素材不存在',
  'external-asset': '候选引用了工程外素材',
  'invalid-path': '候选素材引用越出工程根',
  'purpose-mismatch': '素材类别与引用方式不一致',
  'identity-mismatch': '候选场景与生成目标不是同一个场景',
  'implicit-speaker': '对白姓名不明确，不能进入候选预览',
  'automatic-effect-before-end': '音效会在玩家听到前被清除',
  'missing-background': '连续对白缺少已建立的背景，不能进入候选预览',
  'missing-character': '连续对白缺少已建立的角色，不能进入候选预览',
  'scene-locked': '目标场景已锁定，不能覆盖',
  'lock-unknown': '目标场景锁定状态不明，不能覆盖',
  'baseline-changed': '目标场景基线已变化，不能覆盖',
  'baseline-unknown': '目标场景基线不明，不能覆盖'
}

/**
 * 已知问题只返回固定说明。未知码和原始文本都不能进入渲染或修正提示。
 * 素材引用增强字段只透出契约事实；工程路径 nearestAssetPath 不进渲染状态。
 */
export function safeSceneValidationIssueMessage(code: string): string | undefined {
  return KNOWN_ISSUE_MESSAGE[code]
}
function renderKnownIssues(
  execution: SceneGenerationExecution
): NonNullable<SceneGenerationRenderStatusVO['knownIssues']> {
  return (execution.artifactValidation?.issues ?? []).flatMap((issue) => {
    const message = KNOWN_ISSUE_MESSAGE[issue.code]
    if (!message) return []
    return [
      {
        code: issue.code,
        message,
        ...(issue.sequence === undefined ? {} : { sequence: issue.sequence }),
        correctable: issue.correctable,
        requiresHumanDecision: issue.requiresHumanDecision,
        ...(issue.reference === undefined ? {} : { reference: issue.reference }),
        ...(issue.line === undefined ? {} : { line: issue.line }),
        ...(issue.nearestReference === undefined
          ? {}
          : { nearestReference: issue.nearestReference }),
        ...(issue.nearestAssetName === undefined
          ? {}
          : { nearestAssetName: issue.nearestAssetName })
      }
    ]
  })
}

/**
 * 失败分类优先执行记录，旧记录按现有原因映射；未知分类或原因不补造。
 */
function renderFailureClass(execution: SceneGenerationExecution): FailureClass | undefined {
  const failure = execution.failure
  if (failure?.failureClass) return failure.failureClass
  return failure?.reason ? failureClassOfLegacyReason(failure.reason) : undefined
}

/** 下一步动作优先执行记录，缺省按分类映射；没有分类时不补造。 */
function renderNextActions(
  execution: SceneGenerationExecution,
  failureClass: FailureClass | undefined
): readonly NextAction[] | undefined {
  const recorded = execution.failure?.nextActions
  if (recorded && recorded.length > 0) return recorded
  return failureClass ? NEXT_ACTIONS[failureClass] : undefined
}

/**
 * 旧记录近似：failed 且执行记录本身缺少失败分类或下一步动作。分类和动作可以从
 * 旧原因推导，但推导结果仍标旧记录；当前记录遇到未能分类的失败也会缺字段，
 * 因此只用于展示“旧记录”，不反推记录版本。
 */
function isLegacyFailure(execution: SceneGenerationExecution): boolean {
  if (execution.state !== 'failed') return false
  const recorded = execution.failure
  return !recorded?.failureClass || !recorded.nextActions || recorded.nextActions.length === 0
}

const RECENT_PROGRESS_LIMIT = 6

const WAITING_MODEL_MESSAGE = '等待模型响应（连接较慢时可继续等待或取消）'

/**
 * 时间线只接受固定安全文案。执行记录可能来自旧版本或被人工改写，
 * 不能把时间线里的任意字符串直接写给页面。
 */
const SAFE_PROGRESS_MESSAGE: Record<string, true> = {
  ...Object.fromEntries(Object.values(STAGE_MESSAGE).map((message) => [message, true])),
  ...Object.fromEntries(Object.values(INTERRUPT_MESSAGE).map((message) => [message, true])),
  [WAITING_MODEL_MESSAGE]: true
}

/** 进度时间必须是可解析时间，统一重写为 ISO；旧记录里的异常原文不进入状态。 */
function safeProgressTime(value: string): string | undefined {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString()
}

/** 最近 6 条执行时间线安全进度；没有时间线或没有安全文案的旧记录保持缺失。 */
export function recentProgress(
  execution: SceneGenerationExecution
): readonly SceneGenerationRecentProgressVO[] | undefined {
  const timeline = (execution.timeline ?? []).flatMap((entry) => {
    const createdAt = safeProgressTime(entry.createdAt)
    if (!createdAt || !Object.hasOwn(SAFE_PROGRESS_MESSAGE, entry.message)) return []
    return [{ sequence: entry.sequence, createdAt, stage: entry.stage, message: entry.message }]
  })
  return timeline.length === 0 ? undefined : timeline.slice(-RECENT_PROGRESS_LIMIT)
}

/**
 * 失败、取消和待核对中断可按后端明确的只读授权查看已有候选；
 * 暂停仍走恢复语义，不在这里授予只读候选入口。
 */
function previewAuthorizationOf(
  execution: SceneGenerationExecution,
  previewAvailable: boolean
): NonNullable<SceneGenerationRenderStatusVO['previewAuthorization']> | undefined {
  const readOnlyTerminal =
    execution.state === 'failed' ||
    execution.state === 'cancelled' ||
    (execution.state === 'interrupted' && renderStage(execution) !== 'paused')
  if (!readOnlyTerminal) return undefined
  return previewAvailable ? 'readOnly' : 'unavailable'
}

/**
 * 渲染状态只保留稳定身份、数量摘要、累计 Token、固定文案和安全校验问题。
 * `previewAvailable` 表示候选已发布且生成校验没有阻断问题。
 */
export function toRenderStatusVO(
  execution: SceneGenerationExecution,
  checkpointCanContinue = false
): SceneGenerationRenderStatusVO {
  const stage = renderStage(execution)
  const terminal =
    execution.state === 'succeeded' ||
    execution.state === 'failed' ||
    execution.state === 'cancelled'
  const checkpoint = execution.checkpointId
    ? {
        checkpointId: execution.checkpointId,
        operationId: execution.operationId,
        threadId: execution.threadId,
        branchId: execution.branchId,
        canContinue: checkpointCanContinue,
        candidateSnapshotId: execution.candidateSnapshotId
      }
    : undefined
  const answeredQuestions = renderAnsweredQuestions(execution)
  const userMessages = renderUserMessages(execution)
  const knownIssues = renderKnownIssues(execution)
  const activity = renderActivity(execution)
  const recent = recentProgress(execution)
  const previewAvailable =
    execution.candidateSnapshotId !== undefined &&
    execution.artifactValidation !== undefined &&
    knownIssues.length === 0
  const previewAuthorization = previewAuthorizationOf(execution, previewAvailable)
  return {
    projectId: execution.projectId,
    sceneId: execution.sceneId,
    operationId: execution.operationId,
    threadId: execution.threadId,
    branchId: execution.branchId,
    ...(execution.checkpointId ? { checkpointId: execution.checkpointId } : {}),
    state: execution.state,
    stage,
    stageMessage: renderStageMessage(stage, execution.interruptReason, execution.live),
    attempt: execution.attempt,
    sequence: execution.sequence,
    ...(execution.updatedAt ? { updatedAt: execution.updatedAt } : {}),
    canPause: canRequestSceneGenerationPause(execution),
    canResume:
      canResumePausedSceneGeneration(execution, checkpoint) ||
      canResumeInterruptedSceneGeneration(execution, checkpoint),
    canCancel: !terminal && execution.state !== 'cancelling',
    resumeReason: execution.resumeReason,
    inputSummary: inputSummary(execution),
    usage: renderUsage(execution),
    ...(activity ? { activity } : {}),
    ...(recent ? { recentProgress: recent } : {}),
    // running 表示上一轮人工交互已结算，运行期不再透出审阅入口；waiting 仍必须输出。
    interaction:
      execution.state === 'running'
        ? undefined
        : execution.interaction
          ? renderInteraction(execution.interaction)
          : undefined,
    ...(answeredQuestions ? { answeredQuestions } : {}),
    ...(userMessages ? { userMessages } : {}),
    ...(execution.mode ? { mode: execution.mode } : {}),
    ...(execution.repairSource ? { repairSource: execution.repairSource } : {}),
    candidateSnapshotId: execution.candidateSnapshotId,
    ...(previewAuthorization ? { previewAuthorization } : {}),
    ...(knownIssues.length > 0 ? { knownIssues } : {}),
    previewAvailable,
    result: execution.result ? { commitId: execution.result.commitId } : undefined,
    failure: safeRenderFailure(execution)
  }
}

export function toRenderProgressEvent(
  execution: SceneGenerationExecution,
  checkpointCanContinue = false
): SceneGenerationRenderProgressEventVO {
  const status = toRenderStatusVO(execution, checkpointCanContinue)
  return { ...status, message: status.stageMessage }
}

export function toTimeline(
  execution: SceneGenerationExecution
): readonly SceneGenerationTimelineEntryVO[] {
  return (execution.timeline ?? []).map((entry) => ({ ...entry }))
}

export function historyBoundary(
  execution: SceneGenerationExecution
): SceneGenerationHistoryBoundary | undefined {
  if (execution.state === 'succeeded') return 'committed'
  if (execution.state === 'failed' || execution.interruptReason === 'commitUnknown') return 'failed'
  if (execution.state === 'cancelled') return 'cancelled'
  if (execution.interruptReason === 'paused') return 'paused'
  if (execution.interruptReason === 'candidateConflict') return 'failed'
  if (execution.state === 'waiting' && execution.interaction?.kind === 'decision') {
    return 'waitingDecision'
  }
  if (execution.state === 'waiting') return 'waitingReview'
  if (execution.candidateSnapshotId) return 'candidateCreated'
  if (execution.state === 'pending' || execution.state === 'running') return 'started'
  return undefined
}

export function toHistorySummary(
  execution: SceneGenerationExecution,
  createdAt: string
): SceneGenerationHistorySummaryVO | undefined {
  const boundary = historyBoundary(execution)
  if (!boundary || !execution.checkpointId) return undefined
  const stage = renderStage(execution)
  return {
    projectId: execution.projectId,
    sceneId: execution.sceneId,
    operationId: execution.operationId,
    threadId: execution.threadId,
    branchId: execution.branchId,
    checkpointId: execution.checkpointId,
    boundary,
    stage,
    message: renderStageMessage(stage, execution.interruptReason),
    createdAt,
    candidateSnapshotId: execution.candidateSnapshotId,
    commitId: execution.result?.commitId,
    // 只在真实失败终态补原因；待核对中断保留“提交结果待核对”，不把底层原因当失败原因。
    ...(boundary === 'failed' && execution.state === 'failed' && execution.failure?.reason
      ? { failureReason: execution.failure.reason }
      : {}),
    ...(isLegacyFailure(execution) ? { legacy: true } : {})
  }
}

type SceneGenerationFailureReason = NonNullable<
  NonNullable<SceneGenerationExecution['failure']>['reason']
>

const FAILURE_REASON_MESSAGE: Record<SceneGenerationFailureReason, string> = {
  noInformationGain: '重复读取没有获得新内容，本次生成已停止',
  missingCandidateWrite: '收到完成提示后仍未写出候选，本次生成已停止',
  outputTruncated: '模型输出达到长度上限，本次生成未完成',
  missingStructuredResult: '模型没有提交结构化结果，本次生成未完成',
  structuredOutput: '模型输出不符合约定，本次生成未完成',
  modelFailure: '模型调用失败，本次生成未完成',
  modelRejected: '模型拒绝了本次请求，请核对连接设置',
  modelAccess: '模型鉴权失败，请检查连接设置',
  contextOverflow: '输入超出模型可处理范围，本次生成未完成',
  correctionsExhausted: '自动修正次数已用尽，请审阅候选后手动修改'
}

const SAFE_FAILURE_MESSAGE: Record<string, true> = {
  ...Object.fromEntries(Object.values(FAILURE_REASON_MESSAGE).map((message) => [message, true])),
  ...Object.fromEntries(Object.values(STAGE_MESSAGE).map((message) => [message, true])),
  ...Object.fromEntries(Object.values(INTERRUPT_MESSAGE).map((message) => [message, true])),
  '模型连接中断，本次生成未完成。': true,
  提交结果待核对: true
}

/** 已确认的旧版安全文案到当前固定文案的精确映射；只登记确认过的原文，不扩大安全集合。 */
const LEGACY_FAILURE_MESSAGE: Record<string, string> = {
  '连续读取没有获得新内容，本次生成已停止': FAILURE_REASON_MESSAGE.noInformationGain
}

/** 原因优先固定文案；旧记录先映射已登记的旧版文案，其它未知原文回退阶段文案。 */
function safeFailureMessage(execution: SceneGenerationExecution): string | undefined {
  const failure = execution.failure
  if (!failure) return undefined
  const fixed = failure.reason ? FAILURE_REASON_MESSAGE[failure.reason] : undefined
  if (fixed) return fixed
  const persisted = safeDisplayText(failure.message)
  if (Object.hasOwn(SAFE_FAILURE_MESSAGE, persisted)) return persisted
  if (Object.hasOwn(LEGACY_FAILURE_MESSAGE, persisted)) return LEGACY_FAILURE_MESSAGE[persisted]
  return renderStageMessage(renderStage(execution))
}

function safeRenderFailure(
  execution: SceneGenerationExecution
): NonNullable<SceneGenerationRenderStatusVO['failure']> | undefined {
  const failure = execution.failure
  const reference = failure?.diagnosticRef
  const failureClass = renderFailureClass(execution)
  const nextActions = renderNextActions(execution, failureClass)
  const legacy = isLegacyFailure(execution)
  const safeFacts = {
    ...(failureClass ? { failureClass } : {}),
    ...(nextActions && nextActions.length > 0 ? { nextActions: [...nextActions] } : {}),
    ...(legacy ? { legacy: true } : {})
  }
  if (execution.interruptReason === 'commitUnknown') {
    return {
      code: ErrorCodes.operationConflict,
      message: INTERRUPT_MESSAGE.commitUnknown,
      ...(failure?.reason ? { reason: failure.reason } : {}),
      ...(reference ? { reference } : {}),
      unverified: true,
      ...safeFacts
    }
  }
  if (execution.interruptReason === 'candidateConflict') {
    return {
      code: ErrorCodes.operationConflict,
      message: INTERRUPT_MESSAGE.candidateConflict,
      ...(failure?.reason ? { reason: failure.reason } : {}),
      ...(reference ? { reference } : {}),
      unverified: false,
      ...safeFacts
    }
  }
  if (!failure) return undefined
  return {
    code: failure.code,
    message: safeFailureMessage(execution) ?? renderStageMessage(renderStage(execution)),
    ...(failure.reason ? { reason: failure.reason } : {}),
    ...(reference ? { reference } : {}),
    unverified: false,
    ...(failure.candidateSnapshotId ? { candidateSnapshotId: failure.candidateSnapshotId } : {}),
    ...(failure.previewAuthorization ? { previewAuthorization: failure.previewAuthorization } : {}),
    ...safeFacts
  }
}
