import { AppException } from '@common/errors/AppException'

import type { SceneGenerationQuestionVO } from '../vo/SceneGenerationVO'

export type FailureClass =
  | 'inputInvalid'
  | 'blocked'
  | 'modelTransient'
  | 'modelAuth'
  | 'modelRejected'
  | 'contextOverflow'
  | 'outputContract'
  | 'noProgress'
  | 'correctionsExhausted'
  | 'internal'

export type NextAction =
  | 'retryOperation'
  | 'retryRepair'
  | 'regenerate'
  | 'checkConnection'
  | 'reviseRequirement'
  | 'reduceInput'
  | 'viewCandidate'
  | 'resume'
  | 'verifyTask'
  | 'returnToCanvas'
  | 'viewInputSummary'
  | 'discard'

export type RunFailureReason =
  | 'noInformationGain'
  | 'missingCandidateWrite'
  | 'outputTruncated'
  | 'missingStructuredResult'
  | 'structuredOutput'

export type RunOutcome =
  | { kind: 'candidate'; candidateSnapshotId: string }
  | { kind: 'questions'; questions: readonly SceneGenerationQuestionVO[] }
  | { kind: 'blocked'; reason: string; candidateSnapshotId?: string; processable: true }
  | { kind: 'finalize'; cause: 'noNewInformation' | 'postWriteNoSubmission' }
  | {
      kind: 'modelError'
      failureClass: 'modelTransient' | 'modelAuth' | 'modelRejected' | 'contextOverflow'
      retryable: boolean
      message: string
    }
  | {
      kind: 'contractError'
      failureClass: 'outputContract' | 'noProgress'
      reason: RunFailureReason
      message: string
      candidateSnapshotId?: string
      degraded: boolean
    }
  | { kind: 'inputInvalid'; message: string }
  | { kind: 'paused' }
  | { kind: 'cancelled' }
  | { kind: 'internal'; message: string }

export const NEXT_ACTIONS: Record<FailureClass, readonly NextAction[]> = {
  inputInvalid: ['returnToCanvas', 'viewInputSummary'],
  blocked: ['reviseRequirement', 'returnToCanvas', 'discard'],
  modelTransient: ['retryOperation', 'viewCandidate'],
  modelAuth: ['checkConnection', 'viewInputSummary'],
  modelRejected: ['reviseRequirement', 'viewInputSummary'],
  contextOverflow: ['reduceInput', 'viewInputSummary'],
  outputContract: ['viewCandidate', 'retryOperation', 'regenerate'],
  noProgress: ['retryRepair', 'viewCandidate', 'regenerate'],
  correctionsExhausted: ['reviseRequirement', 'discard'],
  internal: ['verifyTask']
}

export function nextActionsOf(failureClass: FailureClass): readonly NextAction[] {
  return NEXT_ACTIONS[failureClass]
}

export function failureClassOfLegacyReason(reason: string): FailureClass | undefined {
  switch (reason) {
    case 'noInformationGain':
      return 'noProgress'
    case 'missingCandidateWrite':
    case 'outputTruncated':
    case 'missingStructuredResult':
    case 'structuredOutput':
      return 'outputContract'
    case 'modelFailure':
      return 'modelTransient'
    case 'modelRejected':
      return 'modelRejected'
    case 'modelAccess':
      return 'modelAuth'
    case 'contextOverflow':
      return 'contextOverflow'
    case 'correctionsExhausted':
      return 'correctionsExhausted'
    default:
      return undefined
  }
}

export class SceneGenerationRunFailed extends AppException {
  readonly failureClass: FailureClass
  readonly reason?: RunFailureReason

  constructor(input: {
    failureClass: FailureClass
    reason?: RunFailureReason
    message: string
    code: number
    cause?: unknown
  }) {
    super({
      code: input.code,
      msg: input.message,
      ...(input.cause === undefined ? {} : { cause: input.cause })
    })
    this.name = 'SceneGenerationRunFailed'
    this.failureClass = input.failureClass
    this.reason = input.reason
  }
}
