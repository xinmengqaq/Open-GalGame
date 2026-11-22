import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'

import { AppException } from '@common/errors/AppException'
import { ErrorCodes, errorMessages } from '@common/errors/ErrorCodes'
import { errorFacts } from '@common/errors/errorFacts'
import {
  publicFailureOf
} from '@application/scene-generation/models/SceneGenerationFailureFacts'
import type { SceneGenerationExecution } from '@application/scene-generation/models/SceneGenerationExecution'
import {
  NEXT_ACTIONS,
  SceneGenerationRunFailed,
  failureClassOfLegacyReason,
  nextActionsOf
} from '@application/scene-generation/models/SceneGenerationRunOutcome'
import {
  configureDiagnosticHash,
  diagnosticFactPayload,
  recordedFailureOf,
  safeFailureWithDiagnosticRef
} from '@application/scene-generation/services/impl/SceneGenerationFailureFacts'
import { toStatusVO } from '@application/scene-generation/mapping/SceneGenerationViewMapper'
import type {
  FailureClass,
  NextAction
} from '@application/scene-generation/vo/SceneGenerationFailureVO'
import { evaluateContextBudget } from '@infrastructure/ai/context/contextBudget'

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

const secret = 'sk-live-secret'
const leakedUrl = 'https://provider.example/v1/chat?key=secret'
const leakedHeader = 'authorization: Bearer secret'
const leakedStack = 'Error: provider\n    at fetch (C:/secret/project/start.txt:12:3)'

configureDiagnosticHash((payload) =>
  createHash('sha256').update(payload).digest('hex').slice(0, 12)
)

const safeFailure = safeFailureWithDiagnosticRef

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

  it('安全失败事实按分类映射原因与动作，并用同一组事实生成 12 位诊断编号', () => {
    const cause = Object.assign(new Error('provider raw'), {
      name: 'APIError',
      status: 401,
      headers: { authorization: leakedHeader },
      url: leakedUrl,
      stack: leakedStack
    })
    const error = new AppException({
      code: ErrorCodes.forbidden,
      msg: '模型鉴权失败',
      cause,
      diagnosticCategory: 'auth'
    })
    const facts = errorFacts(error)
    const reference = createHash('sha256')
      .update(diagnosticFactPayload(facts, 'auth')!)
      .digest('hex')
      .slice(0, 12)

    expect(reference).toMatch(/^[0-9a-f]{12}$/)
    expect(safeFailure(error)).toEqual({
      code: ErrorCodes.forbidden,
      message: '模型鉴权失败',
      reason: 'modelAccess',
      failureClass: 'modelAuth',
      nextActions: NEXT_ACTIONS.modelAuth,
      category: 'auth',
      httpStatus: 401,
      causeName: 'APIError',
      diagnosticRef: reference
    })
    expect(JSON.stringify(safeFailure(error))).not.toContain(secret)
    expect(JSON.stringify(safeFailure(error))).not.toContain(leakedUrl)
    expect(JSON.stringify(safeFailure(error))).not.toContain(leakedHeader)
    expect(JSON.stringify(safeFailure(error))).not.toContain(leakedStack)
  })

  it('拒绝恶意原因名，非项目异常回退固定文案且不外泄原文', () => {
    const cause = Object.assign(new Error(`${secret} ${leakedUrl}`), {
      name: `https://evil.example/${secret}`,
      status: '401',
      stack: leakedStack
    })
    const error = new Error(`${leakedHeader} ${leakedStack}`)
    error.cause = cause

    const failure = safeFailure(error)
    const serialized = JSON.stringify(failure)
    expect(failure).toEqual({
      code: ErrorCodes.internalError,
      message: errorMessages[ErrorCodes.internalError],
      diagnosticRef: createHash('sha256')
        .update(diagnosticFactPayload(errorFacts(error))!)
        .digest('hex')
        .slice(0, 12)
    })
    expect(failure.causeName).toBeUndefined()
    expect(failure.httpStatus).toBeUndefined()
    expect(failure.reason).toBeUndefined()
    expect(serialized).not.toContain(secret)
    expect(serialized).not.toContain('http')
    expect(serialized).not.toContain('authorization')
    expect(serialized).not.toContain('start.txt')
  })

  it('状态映射输出原因、安全分类与动作和诊断编号，提交结果不明才标待核对', () => {
    const failure = safeFailure(
      new AppException({
        code: ErrorCodes.operationConflict,
        msg: '重复读取没有获得新内容，本次生成已停止',
        diagnosticCategory: 'no-progress'
      })
    )
    const failed = execution({ failure, interruptReason: 'candidateConflict' })
    const unknown = execution({ failure, interruptReason: 'commitUnknown' })

    expect(toStatusVO(failed, false).failure).toEqual({
      code: failure.code,
      message: failure.message,
      reason: 'noInformationGain',
      failureClass: 'noProgress',
      nextActions: NEXT_ACTIONS.noProgress,
      reference: failure.diagnosticRef
    })
    expect(toStatusVO(unknown, false).failure).toEqual({
      code: failure.code,
      message: failure.message,
      reason: 'noInformationGain',
      failureClass: 'noProgress',
      nextActions: NEXT_ACTIONS.noProgress,
      reference: failure.diagnosticRef,
      unverified: true
    })
    expect(
      toStatusVO(execution({ failure: { code: 5102, message: '提交结果待核对' } }), false).failure
    ).toEqual({ code: 5102, message: '提交结果待核对' })
    expect(JSON.stringify(toStatusVO(failed, false))).not.toContain('category')
    expect(publicFailureOf(failure).reference).toBe(failure.diagnosticRef)
  })

  it('模型错误分类和上下文溢出进入对应原因', () => {
    const categories = [
      ['no-progress', 'noInformationGain'],
      ['completion', 'missingCandidateWrite'],
      ['output-truncated', 'outputTruncated'],
      ['missing-structured-result', 'missingStructuredResult'],
      ['structured-output', 'structuredOutput'],
      ['sdk', 'modelFailure'],
      ['streaming', 'modelFailure'],
      ['tool', 'modelFailure'],
      ['request', 'modelRejected'],
      ['auth', 'modelAccess'],
      ['context', 'contextOverflow']
    ] as const
    for (const [category, reason] of categories) {
      expect(
        safeFailure(new AppException({ code: 4101, msg: '安全说明', diagnosticCategory: category }))
          .reason
      ).toBe(reason)
    }
    expect(
      safeFailure(new AppException({ code: 4101, msg: '安全说明', diagnosticCategory: 'unknown' }))
        .reason
    ).toBeUndefined()

    expect(() =>
      evaluateContextBudget({
        windowTokens: 40,
        safetyFraction: 0.1,
        reservedOutputTokens: 10,
        systemPrompt: '必须保留'.repeat(20),
        toolDefinitions: [],
        messages: [{ content: '必须留下', required: true }]
      })
    ).toThrow(AppException)
    try {
      evaluateContextBudget({
        windowTokens: 40,
        safetyFraction: 0.1,
        reservedOutputTokens: 10,
        systemPrompt: '必须保留'.repeat(20),
        toolDefinitions: [],
        messages: [{ content: '必须留下', required: true }]
      })
    } catch (error) {
      expect(safeFailure(error)).toMatchObject({ reason: 'contextOverflow', category: 'context' })
    }
  })

  it('包装后的恢复失败仍能找到原始失败的同一诊断编号', () => {
    const original = new AppException({
      code: ErrorCodes.forbidden,
      msg: '模型鉴权失败',
      cause: Object.assign(new Error('provider raw'), { name: 'APIError', status: 401 }),
      diagnosticCategory: 'auth'
    })
    const wrapped = new AppException({
      code: ErrorCodes.operationConflict,
      msg: '作品提交结果尚未查明，已保留候选与恢复记录',
      cause: original
    })
    const recovered = new AppException({
      code: ErrorCodes.internalError,
      msg: '场景生成未完整结束，请核对并恢复该操作',
      cause: new AggregateError([original, new Error('recovery raw')], '场景生成与恢复失败')
    })

    expect(recordedFailureOf(wrapped)?.diagnosticRef).toBe(safeFailure(original).diagnosticRef)
    expect(recordedFailureOf(recovered)?.diagnosticRef).toBe(safeFailure(original).diagnosticRef)
    expect(recordedFailureOf(original)).toBeUndefined()
  })

  it('失败事实保留可读候选和只读授权，不保留路径或模型原文', () => {
    const candidate = {
      candidateSnapshotId: 'candidate-1',
      previewAuthorization: 'readOnly' as const,
      sourcePath: 'D:/secret/start.txt',
      modelOutput: 'raw model text'
    }
    const failure = safeFailure(
      new AppException({
        code: ErrorCodes.operationConflict,
        msg: '智能体未通过文件工具实际写入候选脚本',
        diagnosticCategory: 'completion'
      }),
      candidate
    )
    expect(failure).toMatchObject({
      candidateSnapshotId: 'candidate-1',
      previewAuthorization: 'readOnly'
    })
    expect(JSON.stringify(failure)).not.toContain('D:/secret')
    expect(JSON.stringify(failure)).not.toContain('raw model text')
    expect(publicFailureOf(failure)).toMatchObject({
      candidateSnapshotId: 'candidate-1',
      previewAuthorization: 'readOnly'
    })
  })

  it('终态失败直接或嵌在聚合与原因链里仍保留分类和下一步动作', () => {
    const runFailed = new SceneGenerationRunFailed({
      failureClass: 'modelAuth',
      reason: 'missingStructuredResult',
      message: 'x',
      code: ErrorCodes.forbidden
    })
    expect(safeFailure(runFailed)).toMatchObject({
      code: ErrorCodes.forbidden,
      message: 'x',
      reason: 'missingStructuredResult',
      failureClass: 'modelAuth',
      nextActions: NEXT_ACTIONS.modelAuth
    })

    const aggregated = new AggregateError([new Error('outer'), runFailed], '聚合失败')
    expect(safeFailure(aggregated)).toMatchObject({
      code: ErrorCodes.forbidden,
      message: 'x',
      reason: 'missingStructuredResult',
      failureClass: 'modelAuth',
      nextActions: NEXT_ACTIONS.modelAuth
    })

    const chained = new Error('outer')
    chained.cause = runFailed
    expect(safeFailure(chained)).toMatchObject({
      failureClass: 'modelAuth',
      nextActions: NEXT_ACTIONS.modelAuth
    })
  })

  it('公开错误缺原因和诊断字段时回落到原错误的分类与原因事实', () => {
    const original = new AppException({
      code: ErrorCodes.forbidden,
      msg: '模型鉴权失败',
      diagnosticCategory: 'auth',
      cause: Object.assign(new Error('provider raw'), { name: 'APIError', status: 401 })
    })
    const recorded = new SceneGenerationRunFailed({
      failureClass: 'modelAuth',
      message: '模型鉴权失败',
      code: ErrorCodes.forbidden,
      cause: original
    })

    const expected = safeFailure(original)
    expect(safeFailure(recorded)).toEqual(expected)

    const narrowed = new SceneGenerationRunFailed({
      failureClass: 'outputContract',
      reason: 'outputTruncated',
      message: '模型输出达到长度上限，本次生成未完成',
      code: ErrorCodes.operationConflict,
      cause: original
    })
    const facts = safeFailure(narrowed)
    expect(facts).toMatchObject({
      reason: 'outputTruncated',
      failureClass: 'outputContract',
      category: 'auth',
      httpStatus: 401,
      causeName: 'APIError'
    })
    expect(facts.diagnosticRef).toBe(expected.diagnosticRef)
  })

  it('候选只读授权只在存在候选时写入失败事实', () => {
    const withCandidate = safeFailure(new Error('x'), {
      candidateSnapshotId: 'c1',
      previewAuthorization: 'readOnly'
    })
    expect(withCandidate).toMatchObject({
      candidateSnapshotId: 'c1',
      previewAuthorization: 'readOnly'
    })

    const withoutCandidate = safeFailure(new Error('x'))
    expect(withoutCandidate.candidateSnapshotId).toBeUndefined()
    expect(withoutCandidate.previewAuthorization).toBeUndefined()
  })
})

function execution(patch: Partial<SceneGenerationExecution>): SceneGenerationExecution {
  return {
    projectId: 'project-1',
    sceneId: 'scene-1',
    operationId: 'operation-1',
    threadId: 'thread-1',
    branchId: 'branch-1',
    fingerprint: 'fingerprint-1',
    source: {
      projectId: 'project-1',
      sceneId: 'scene-1',
      projectRoot: '/project',
      sceneDirectory: 'game/scene',
      entryFile: 'start.txt'
    },
    inputSnapshot: {
      canvasId: 'canvas-1',
      arrangementVersion: 'v1',
      assets: [],
      documents: [],
      prompts: [],
      fieldBindings: [],
      relations: [],
      confirmedControls: []
    },
    policy: { maxCorrections: 1 },
    reviewCandidate: false,
    baseline: { commitId: 'base', affectedFiles: [], lockState: 'unlocked' },
    state: 'failed',
    phase: 'failed',
    attempt: 1,
    sequence: 1,
    budget: { correctionsUsed: 0, modelCallsUsed: 0, toolCallsUsed: 0, activeElapsedMs: 0 },
    replies: [],
    ...patch
  }
}
