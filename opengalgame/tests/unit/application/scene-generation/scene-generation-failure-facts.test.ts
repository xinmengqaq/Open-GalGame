import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'

import {
  NEXT_ACTIONS,
  SceneGenerationRunFailed
} from '@application/scene-generation/models/SceneGenerationRunOutcome'
import { safeFailure } from '@application/scene-generation/services/impl/SceneGenerationApplicationRules'
import {
  configureDiagnosticHash,
  diagnosticFactPayload,
  publicFailureOf,
  recordedFailureOf
} from '@application/scene-generation/services/impl/SceneGenerationFailureFacts'
import { toStatusVO } from '@application/scene-generation/mapping/SceneGenerationViewMapper'
import { AppException } from '@common/errors/AppException'
import { ErrorCodes, errorMessages } from '@common/errors/ErrorCodes'
import { errorFacts } from '@common/errors/errorFacts'
import { evaluateContextBudget } from '@infrastructure/ai/context/contextBudget'
import { normalizeAgentError } from '@infrastructure/ai/middleware/retryPolicy'

const secret = 'sk-live-secret'
const leakedUrl = 'https://provider.example/v1/chat?key=secret'
const leakedHeader = 'authorization: Bearer secret'
const leakedStack = 'Error: provider\n    at fetch (C:/secret/project/start.txt:12:3)'

configureDiagnosticHash((payload) =>
  createHash('sha256').update(payload).digest('hex').slice(0, 12)
)

describe('场景生成失败事实', () => {
  it('按分类映射原因，并用同一组事实生成 12 位诊断编号', () => {
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
    expect(reference).toBe(
      createHash('sha256')
        .update(
          JSON.stringify({
            errorName: facts.errorName,
            causeNames: facts.causeNames,
            causeCodes: facts.causeCodes,
            statuses: facts.statuses,
            category: 'auth'
          })
        )
        .digest('hex')
        .slice(0, 12)
    )
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

    const auth = normalizeAgentError(Object.assign(new Error('raw 401'), { status: 401 }))
    const request = normalizeAgentError(Object.assign(new Error('raw 400'), { status: 400 }))
    expect(safeFailure(auth)).toMatchObject({ code: 4102, reason: 'modelAccess', httpStatus: 401 })
    expect(safeFailure(request)).toMatchObject({
      code: 4101,
      reason: 'modelRejected',
      httpStatus: 400
    })
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
    const failure = safeFailure(
      new AppException({
        code: ErrorCodes.operationConflict,
        msg: '智能体未通过文件工具实际写入候选脚本',
        diagnosticCategory: 'completion'
      }),
      {
        candidateSnapshotId: 'candidate-1',
        previewAuthorization: 'readOnly',
        sourcePath: 'D:/secret/start.txt',
        modelOutput: 'raw model text'
      }
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

  it('旧失败原因映射分类，未知错误不补造分类', () => {
    const legacy = new AppException({
      code: ErrorCodes.operationConflict,
      msg: '重复读取没有获得新内容，本次生成已停止',
      diagnosticCategory: 'no-progress'
    })
    expect(safeFailure(legacy)).toMatchObject({
      reason: 'noInformationGain',
      failureClass: 'noProgress',
      nextActions: NEXT_ACTIONS.noProgress
    })

    const unknown = safeFailure(new Error('x'))
    expect(unknown.failureClass).toBeUndefined()
    expect(unknown.nextActions).toBeUndefined()
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
