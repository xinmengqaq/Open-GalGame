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

export const FAILURE_CAUSE_NAME = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/

export type SceneGenerationFailureCandidateFacts = {
  candidateSnapshotId?: string
  previewAuthorization?: SceneGenerationCandidatePreviewAuthorization
}

export type SceneGenerationFailureFact = {
  code: number
  message: string
  reason?: SceneGenerationFailureReason
  failureClass?: FailureClass
  nextActions?: readonly NextAction[]
  category?: NonNullable<AppException['diagnosticCategory']>
  httpStatus?: number
  causeName?: string
  diagnosticRef?: string
  candidateSnapshotId?: string
  previewAuthorization?: SceneGenerationCandidatePreviewAuthorization
}

export type SceneGenerationFailureAnalysis = {
  recorded?: SceneGenerationRunFailed
  facts: ErrorFacts
  category?: NonNullable<AppException['diagnosticCategory']>
}

export type SceneGenerationFailureFactBuilder = (
  error: unknown,
  candidate?: SceneGenerationFailureCandidateFacts
) => SceneGenerationFailureFact

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

export function analyzeSceneGenerationFailure(error: unknown): SceneGenerationFailureAnalysis {
  const recorded = firstRunFailed(error)
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

export function nestedFailureCauses(error: unknown): unknown[] {
  if (typeof error !== 'object' || error === null) return []
  return [
    ...('cause' in error ? [error.cause] : []),
    ...('errors' in error && Array.isArray(error.errors) ? error.errors : [])
  ]
}

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
