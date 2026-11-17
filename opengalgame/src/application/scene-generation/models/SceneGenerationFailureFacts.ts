import {
  failureClassOfLegacyReason,
  NEXT_ACTIONS,
  SceneGenerationRunFailed
} from './SceneGenerationRunOutcome'
import type {
  FailureClass,
  NextAction,
  SceneGenerationCandidatePreviewAuthorization,
  SceneGenerationFailureReason,
  SceneGenerationPublicFailure
} from '../vo/SceneGenerationFailureVO'
import { AppException } from '@common/errors/AppException'
import { errorFacts, type ErrorFacts } from '@common/errors/errorFacts'
import { ErrorCodes, errorMessages } from '@common/errors/ErrorCodes'

/** 只接受稳定类名。路径、URL 和任意原文不能成为原因名。 */
export const FAILURE_CAUSE_NAME = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/

export type SceneGenerationFailureCandidateFacts = {
  candidateSnapshotId?: string
  previewAuthorization?: SceneGenerationCandidatePreviewAuthorization
}

export type SceneGenerationFailureFact = {
  code: number
  message: string
  reason?: SceneGenerationFailureReason
  /** 失败分类随执行记录持久化，并可按安全投影公开；诊断分类、状态和原因名不公开。 */
  failureClass?: FailureClass
  /** 按失败分类给出的下一步动作，主动作在前。 */
  nextActions?: readonly NextAction[]
  category?: NonNullable<AppException['diagnosticCategory']>
  httpStatus?: number
  causeName?: string
  diagnosticRef?: string
  /** 失败时仍可读的候选修订。缺失表示没有可查看候选。 */
  candidateSnapshotId?: string
  /** 失败候选只读授权。缺失表示旧记录没有该事实。 */
  previewAuthorization?: SceneGenerationCandidatePreviewAuthorization
}

/** 诊断边界一次分析的结果。纯事实只读取它，不持有 hash/config。 */
export type SceneGenerationFailureAnalysis = {
  recorded?: SceneGenerationRunFailed
  facts: ErrorFacts
  category?: NonNullable<AppException['diagnosticCategory']>
}

/** 诊断边界注入的失败事实构建器；实现负责生成诊断编号。 */
export type SceneGenerationFailureFactBuilder = (
  error: unknown,
  candidate?: SceneGenerationFailureCandidateFacts
) => SceneGenerationFailureFact

/** 已知分类才映射原因。未知分类不补造原因。 */
export function failureReasonOf(
  category: AppException['diagnosticCategory'] | undefined,
  causeNames: readonly string[] = []
): SceneGenerationFailureReason | undefined {
  if (category === 'no-progress') return 'noInformationGain'
  if (category === 'completion') return 'missingCandidateWrite'
  if (category === 'output-truncated') return 'outputTruncated'
  if (category === 'missing-structured-result') return 'missingStructuredResult'
  if (category === 'structured-output') return 'structuredOutput'
  if (category === 'request') return 'modelRejected'
  if (category === 'auth') return 'modelAccess'
  if (category === 'context') return 'contextOverflow'
  if (
    category === 'sdk' ||
    category === 'streaming' ||
    category === 'tool' ||
    causeNames.some((name) =>
      ['APIError', 'APIConnectionError', 'ModelStreamParseError'].includes(name)
    )
  ) {
    return 'modelFailure'
  }
  return undefined
}

/** 一次完成异常选择、原因链事实与分类分析；诊断编号由持有 hash 的边界计算。 */
export function analyzeSceneGenerationFailure(error: unknown): SceneGenerationFailureAnalysis {
  const recorded = firstRunFailed(error)
  // 公开错误只带窄原因和分类；原错误链才持有分类名、状态和诊断载荷。
  // 找到公开错误时按原错误回落，不把窄字段当成全部事实。
  const diagnostic = recorded ? (recorded.cause ?? error) : error
  const facts = errorFacts(diagnostic)
  const category = recorded
    ? diagnosticCategoryIn(diagnostic)
    : error instanceof AppException
      ? error.diagnosticCategory
      : undefined
  return {
    ...(recorded ? { recorded } : {}),
    facts,
    ...(category ? { category } : {})
  }
}

/** 只组装可持久化的失败事实。诊断编号由诊断边界预先计算，本函数不读取 hash/config。 */
export function safeFailure(
  error: unknown,
  analysis: SceneGenerationFailureAnalysis,
  candidate?: SceneGenerationFailureCandidateFacts,
  diagnosticRef?: string
): SceneGenerationFailureFact {
  const { recorded, facts, category } = analysis
  const httpStatus = facts.statuses.find((status) => Number.isInteger(status))
  const causeName = facts.causeNames.find((name) => FAILURE_CAUSE_NAME.test(name))
  const reason = recorded?.reason ?? failureReasonOf(category, facts.causeNames)
  const failureClass =
    recorded?.failureClass ?? (reason ? failureClassOfLegacyReason(reason) : undefined)
  return {
    code: recorded?.code ?? (error instanceof AppException ? error.code : ErrorCodes.internalError),
    message:
      recorded?.message ??
      (error instanceof AppException ? error.message : errorMessages[ErrorCodes.internalError]),
    ...(reason ? { reason } : {}),
    ...(failureClass ? { failureClass } : {}),
    ...(failureClass ? { nextActions: NEXT_ACTIONS[failureClass] } : {}),
    ...(category ? { category } : {}),
    ...(httpStatus === undefined ? {} : { httpStatus }),
    ...(causeName ? { causeName } : {}),
    ...(diagnosticRef ? { diagnosticRef } : {}),
    ...(candidate?.candidateSnapshotId
      ? { candidateSnapshotId: candidate.candidateSnapshotId }
      : {}),
    ...(candidate?.previewAuthorization
      ? { previewAuthorization: candidate.previewAuthorization }
      : {})
  }
}

/** 对外只保留安全文案、原因、失败分类、下一步动作和诊断编号。诊断分类、状态和原因名不跨进程。 */
export function publicFailureOf(
  failure: {
    code: number
    message: string
    reason?: string
    failureClass?: FailureClass
    nextActions?: readonly NextAction[]
    diagnosticRef?: string
    candidateSnapshotId?: string
    previewAuthorization?: SceneGenerationCandidatePreviewAuthorization
  },
  unverified = false
): SceneGenerationPublicFailure {
  const reason = isFailureReason(failure.reason) ? failure.reason : undefined
  return {
    code: failure.code,
    message: failure.message,
    ...(reason ? { reason } : {}),
    ...(failure.failureClass ? { failureClass: failure.failureClass } : {}),
    ...(failure.nextActions && failure.nextActions.length > 0
      ? { nextActions: [...failure.nextActions] }
      : {}),
    ...(failure.diagnosticRef ? { reference: failure.diagnosticRef } : {}),
    ...(unverified ? { unverified: true } : {}),
    ...(typeof failure.candidateSnapshotId === 'string' && failure.candidateSnapshotId.length > 0
      ? { candidateSnapshotId: failure.candidateSnapshotId }
      : {}),
    ...('previewAuthorization' in failure &&
    (failure.previewAuthorization === 'readOnly' || failure.previewAuthorization === 'unavailable')
      ? { previewAuthorization: failure.previewAuthorization }
      : {})
  }
}

const FAILURE_REASONS = [
  'noInformationGain',
  'missingCandidateWrite',
  'outputTruncated',
  'missingStructuredResult',
  'structuredOutput',
  'modelFailure',
  'modelRejected',
  'modelAccess',
  'contextOverflow',
  'correctionsExhausted'
] as const

function isFailureReason(value: string | undefined): value is SceneGenerationFailureReason {
  return FAILURE_REASONS.some((reason) => reason === value)
}

/** 广度优先找回带分类的终态失败，包装层不丢失分类语义。 */
function firstRunFailed(error: unknown): SceneGenerationRunFailed | undefined {
  const seen = new Set<unknown>()
  const queue: unknown[] = [error]
  while (queue.length > 0) {
    const current = queue.shift()
    if (current === undefined || current === null || seen.has(current)) continue
    seen.add(current)
    if (current instanceof SceneGenerationRunFailed) return current
    queue.push(...nestedFailureCauses(current))
  }
  return undefined
}

/** 与诊断边界的未持久化事实遍历保持同一顺序。 */
export function nestedFailureCauses(error: unknown): unknown[] {
  if (typeof error !== 'object' || error === null) return []
  return [
    ...('cause' in error ? [error.cause] : []),
    ...('errors' in error && Array.isArray(error.errors) ? error.errors : [])
  ]
}

/** 在原因链里找回分类，公开错误本身不携带诊断分类。 */
function diagnosticCategoryIn(error: unknown): AppException['diagnosticCategory'] | undefined {
  const seen = new Set<unknown>()
  const queue: unknown[] = [error]
  while (queue.length > 0) {
    const current = queue.shift()
    if (current === undefined || current === null || seen.has(current)) continue
    seen.add(current)
    if (current instanceof AppException && current.diagnosticCategory)
      return current.diagnosticCategory
    queue.push(...nestedFailureCauses(current))
  }
  return undefined
}
