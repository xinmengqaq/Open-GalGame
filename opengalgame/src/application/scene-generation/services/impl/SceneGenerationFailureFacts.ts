import {
  failureClassOfLegacyReason,
  NEXT_ACTIONS,
  SceneGenerationRunFailed,
  type FailureClass,
  type NextAction
} from '@application/scene-generation/models/SceneGenerationRunOutcome'
import { AppException } from '@common/errors/AppException'
import { errorFacts, type ErrorFacts } from '@common/errors/errorFacts'
import { ErrorCodes, errorMessages } from '@common/errors/ErrorCodes'

/** 只接受稳定类名。路径、URL 和任意原文不能成为原因名。 */
export const FAILURE_CAUSE_NAME = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/

export type SceneGenerationFailureReason =
  | 'noInformationGain'
  | 'missingCandidateWrite'
  | 'outputTruncated'
  | 'missingStructuredResult'
  | 'structuredOutput'
  | 'modelFailure'
  | 'modelRejected'
  | 'modelAccess'
  | 'contextOverflow'
  | 'correctionsExhausted'

export type SceneGenerationCandidatePreviewAuthorization = 'readOnly' | 'unavailable'

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

export type SceneGenerationPublicFailure = {
  code: number
  message: string
  reason?: SceneGenerationFailureReason
  /** 安全失败分类。只来自执行记录或旧原因映射，不暴露诊断分类。 */
  failureClass?: FailureClass
  /** 按失败分类给出的下一步动作，主动作在前。 */
  nextActions?: readonly NextAction[]
  reference?: string
  unverified?: boolean
  legacy?: boolean
  candidateSnapshotId?: string
  previewAuthorization?: SceneGenerationCandidatePreviewAuthorization
}

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

/** 返回诊断编号的事实载荷。哈希由持有 node:crypto 的边界完成。 */
export function diagnosticFactPayload(
  facts: ErrorFacts,
  category?: AppException['diagnosticCategory']
): string | undefined {
  if (
    !facts.errorName &&
    facts.causeNames.length === 0 &&
    facts.causeCodes.length === 0 &&
    facts.statuses.length === 0 &&
    !category
  ) {
    return undefined
  }
  return JSON.stringify({
    errorName: facts.errorName,
    causeNames: facts.causeNames,
    causeCodes: facts.causeCodes,
    statuses: facts.statuses,
    category
  })
}

/** 只保留可持久化的失败事实。非项目异常使用固定内部错误文案。 */
export function safeFailure(
  error: unknown,
  candidate?: {
    candidateSnapshotId?: string
    previewAuthorization?: SceneGenerationCandidatePreviewAuthorization
  }
): SceneGenerationFailureFact {
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
  const httpStatus = facts.statuses.find((status) => Number.isInteger(status))
  const causeName = facts.causeNames.find((name) => FAILURE_CAUSE_NAME.test(name))
  const reason = recorded?.reason ?? failureReasonOf(category, facts.causeNames)
  const failureClass =
    recorded?.failureClass ?? (reason ? failureClassOfLegacyReason(reason) : undefined)
  const payload = diagnosticFactPayload(facts, category)
  const diagnosticRef = payload && diagnosticHash ? diagnosticHash(payload) : undefined
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

/** 在包装异常里找到实际持久化的项目异常，保证日志编号与执行记录相同。 */
export function recordedFailureOf(error: unknown): SceneGenerationFailureFact | undefined {
  const seen = new Set<unknown>()
  const queue: unknown[] = nestedCauses(error)
  let recorded: SceneGenerationFailureFact | undefined
  while (queue.length > 0) {
    const current = queue.shift()
    if (current === undefined || current === null || seen.has(current)) continue
    seen.add(current)
    if (typeof current !== 'object') continue
    if (current instanceof AppException && !recorded) recorded = safeFailure(current)
    queue.push(...nestedCauses(current))
  }
  return recorded
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
    queue.push(...nestedCauses(current))
  }
  return undefined
}

function nestedCauses(error: unknown): unknown[] {
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
    queue.push(...nestedCauses(current))
  }
  return undefined
}

let diagnosticHash: ((payload: string) => string) | undefined

export function configureDiagnosticHash(hash: (payload: string) => string): void {
  diagnosticHash = hash
}
