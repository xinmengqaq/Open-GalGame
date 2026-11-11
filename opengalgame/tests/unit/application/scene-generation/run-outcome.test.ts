import { describe, expect, it } from 'vitest'

import { AppException } from '@common/errors/AppException'

import {
  NEXT_ACTIONS,
  SceneGenerationRunFailed,
  failureClassOfLegacyReason,
  nextActionsOf,
  type FailureClass,
  type NextAction
} from '@application/scene-generation/models/SceneGenerationRunOutcome'

const EXPECTED_NEXT_ACTIONS: Record<FailureClass, readonly NextAction[]> = {
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

const LEGACY_REASON_CLASSES: ReadonlyArray<readonly [string, FailureClass]> = [
  ['noInformationGain', 'noProgress'],
  ['missingCandidateWrite', 'outputContract'],
  ['outputTruncated', 'outputContract'],
  ['missingStructuredResult', 'outputContract'],
  ['structuredOutput', 'outputContract'],
  ['modelFailure', 'modelTransient'],
  ['modelRejected', 'modelRejected'],
  ['modelAccess', 'modelAuth'],
  ['contextOverflow', 'contextOverflow'],
  ['correctionsExhausted', 'correctionsExhausted']
]

describe('生成运行结果契约', () => {
  it('下一步动作表恰有十类失败，且数组与冻结表逐字一致', () => {
    const classes = Object.keys(EXPECTED_NEXT_ACTIONS).sort()
    expect(Object.keys(NEXT_ACTIONS).sort()).toEqual(classes)
    expect(Object.keys(NEXT_ACTIONS)).toHaveLength(10)
    for (const failureClass of classes as FailureClass[]) {
      expect(NEXT_ACTIONS[failureClass]).toEqual(EXPECTED_NEXT_ACTIONS[failureClass])
    }
  })

  it('nextActionsOf 返回冻结表中的同一数组引用', () => {
    expect(nextActionsOf('noProgress')).toBe(NEXT_ACTIONS.noProgress)
    expect(nextActionsOf('inputInvalid')).toBe(NEXT_ACTIONS.inputInvalid)
    expect(nextActionsOf('internal')).toBe(NEXT_ACTIONS.internal)
  })

  it('旧失败原因映射到失败分类', () => {
    for (const [reason, failureClass] of LEGACY_REASON_CLASSES) {
      expect(failureClassOfLegacyReason(reason)).toBe(failureClass)
    }
  })

  it('未知旧失败原因返回 undefined，不补造分类', () => {
    expect(failureClassOfLegacyReason('somethingElse')).toBeUndefined()
    expect(failureClassOfLegacyReason('')).toBeUndefined()
  })

  it('SceneGenerationRunFailed 保留分类、原因、错误码、消息和原始原因', () => {
    const cause = new Error('底层原因')
    const failure = new SceneGenerationRunFailed({
      failureClass: 'modelAuth',
      reason: 'missingStructuredResult',
      message: 'x',
      code: 4102,
      cause
    })
    expect(failure).toBeInstanceOf(AppException)
    expect(failure.name).toBe('SceneGenerationRunFailed')
    expect(failure.code).toBe(4102)
    expect(failure.message).toBe('x')
    expect(failure.failureClass).toBe('modelAuth')
    expect(failure.reason).toBe('missingStructuredResult')
    expect(failure.cause).toBe(cause)
  })

  it('SceneGenerationRunFailed 允许省略原因和原始原因', () => {
    const failure = new SceneGenerationRunFailed({
      failureClass: 'internal',
      message: 'y',
      code: 4103
    })
    expect(failure.reason).toBeUndefined()
    expect(failure.cause).toBeUndefined()
  })
})
