import { describe, expect, it } from 'vitest'

import type {
  SceneGenerationCheckpoint,
  SceneGenerationExecution,
  SceneGenerationRepairContext
} from '@application/scene-generation/models/SceneGenerationExecution'
import {
  buildSceneGenerationRepairContext,
  repairContextIssue
} from '@application/scene-generation/policies/SceneGenerationRepairContextPolicy'
import { canRetryFailedSceneGenerationRepair } from '@domain/scene-generation/services/validateSceneGenerationReply'

function sourceExecution(
  overrides: Partial<SceneGenerationExecution> = {}
): SceneGenerationExecution {
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
      sceneDirectory: 'scenes/scene-1',
      entryFile: 'start.txt'
    },
    inputSnapshot: {
      canvasId: 'canvas-1',
      arrangementVersion: 'arrangement-1',
      assets: [],
      documents: [],
      prompts: [],
      fieldBindings: [],
      relations: [],
      confirmedControls: []
    },
    policy: { maxCorrections: 2 },
    reviewCandidate: false,
    baseline: { commitId: 'baseline-1', affectedFiles: [], lockState: 'unlocked' },
    state: 'failed',
    phase: 'failed',
    attempt: 0,
    sequence: 0,
    budget: { correctionsUsed: 0, modelCallsUsed: 0, toolCallsUsed: 0, activeElapsedMs: 0 },
    checkpointId: 'checkpoint-1',
    candidateSnapshotId: 'snapshot-1',
    replies: [],
    ...overrides
  }
}

function sourceCheckpoint(execution: SceneGenerationExecution): SceneGenerationCheckpoint {
  return {
    execution,
    candidateSnapshotId: execution.candidateSnapshotId,
    summary: '来源摘要',
    unresolvedIssues: ['未解决冲突'],
    view: {
      projectId: execution.projectId,
      sceneId: execution.sceneId,
      operationId: execution.operationId,
      threadId: execution.threadId,
      branchId: execution.branchId,
      checkpointId: 'checkpoint-1',
      phase: 'failed',
      summary: '来源摘要',
      decisions: [],
      differences: [],
      canView: true,
      canContinue: false
    }
  }
}

function reviseReply(body: string, kind: 'revise' | 'clarify' = 'revise') {
  return {
    projectId: 'project-1',
    sceneId: 'scene-1',
    operationId: 'operation-1',
    threadId: 'thread-1',
    branchId: 'branch-1',
    interactionId: 'interaction-1',
    checkpointId: 'checkpoint-1',
    candidateSnapshotId: 'snapshot-1',
    replyId: `reply-${kind}-${body}`,
    reply: { kind, body }
  }
}

function contextExecution(context: SceneGenerationRepairContext): SceneGenerationExecution {
  return sourceExecution({
    repairSource: {
      operationId: context.sourceOperationId,
      threadId: context.sourceThreadId,
      branchId: context.sourceBranchId,
      checkpointId: context.sourceCheckpointId,
      candidateSnapshotId: context.sourceCandidateSnapshotId
    },
    repairContext: context
  })
}

function completeContext(
  overrides: Partial<SceneGenerationRepairContext> = {}
): SceneGenerationRepairContext {
  return {
    sourceOperationId: 'operation-1',
    sourceThreadId: 'thread-1',
    sourceBranchId: 'branch-1',
    sourceCheckpointId: 'checkpoint-1',
    sourceCandidateSnapshotId: 'snapshot-1',
    candidatePath: 'scenes/scene-1/start.txt',
    instruction: '改结尾',
    summary: '来源摘要',
    confirmedReplies: [{ kind: 'revise', body: '改结尾' }],
    unresolvedIssues: ['未解决冲突'],
    ...overrides
  }
}

describe('buildSceneGenerationRepairContext', () => {
  it('把源身份、候选坐标、摘要、回复与失败事实映射到上下文', () => {
    const source = sourceExecution({
      replies: [reviseReply('改结尾'), reviseReply('补充语气', 'clarify')],
      artifactValidation: {
        issues: [
          {
            code: 'missing-background',
            message: '缺少背景',
            correctable: true,
            requiresHumanDecision: false
          }
        ]
      },
      failure: {
        code: 4101,
        message: '候选未通过',
        reason: 'structuredOutput',
        failureClass: 'outputContract'
      }
    })
    const context = buildSceneGenerationRepairContext(source, sourceCheckpoint(source), '改结尾')
    expect(context).toEqual({
      sourceOperationId: 'operation-1',
      sourceThreadId: 'thread-1',
      sourceBranchId: 'branch-1',
      sourceCheckpointId: 'checkpoint-1',
      sourceCandidateSnapshotId: 'snapshot-1',
      candidatePath: 'scenes/scene-1/start.txt',
      instruction: '改结尾',
      summary: '来源摘要',
      confirmedReplies: [
        { kind: 'revise', body: '改结尾' },
        { kind: 'clarify', body: '补充语气' }
      ],
      unresolvedIssues: ['未解决冲突'],
      validationReport: {
        issues: [
          {
            code: 'missing-background',
            message: '缺少背景',
            correctable: true,
            requiresHumanDecision: false
          }
        ]
      },
      failureClass: 'outputContract',
      failureReason: 'structuredOutput',
      failureMessage: '候选未通过'
    })
  })

  it('检查点缺少原始摘要时回退旧上下文事实，不补造', () => {
    const previous = completeContext({
      summary: '上次摘要',
      unresolvedIssues: ['旧未解决'],
      validationReport: { issues: [] },
      failureClass: 'outputContract',
      failureMessage: '上次失败'
    })
    const source = sourceExecution({
      repairContext: previous,
      artifactValidation: undefined,
      failure: undefined
    })
    const context = buildSceneGenerationRepairContext(
      source,
      { ...sourceCheckpoint(source), summary: undefined, unresolvedIssues: undefined },
      '继续修改'
    )
    expect(context).toMatchObject({
      summary: '上次摘要',
      unresolvedIssues: ['旧未解决'],
      validationReport: { issues: [] },
      failureClass: 'outputContract',
      failureMessage: '上次失败',
      confirmedReplies: [
        { kind: 'revise', body: '改结尾' },
        { kind: 'revise', body: '继续修改' }
      ]
    })
  })

  it('检查点已清空的摘要和未解决冲突不回退旧上下文', () => {
    const previous = completeContext({
      summary: '上次摘要',
      unresolvedIssues: ['旧未解决']
    })
    const source = sourceExecution({ repairContext: previous })
    const context = buildSceneGenerationRepairContext(
      source,
      { ...sourceCheckpoint(source), summary: '', unresolvedIssues: [] },
      '继续修改'
    )
    expect(context).toMatchObject({ summary: '', unresolvedIssues: [] })
  })

  it('来源未解决冲突超过执行记录上限时以固定安全文案拒绝', () => {
    const source = sourceExecution()
    expect(() =>
      buildSceneGenerationRepairContext(
        source,
        {
          ...sourceCheckpoint(source),
          unresolvedIssues: Array.from({ length: 101 }, (_, index) => `冲突 ${index + 1}`)
        },
        '改结尾'
      )
    ).toThrowError(
      expect.objectContaining({ code: 4103, message: '来源修复上下文过大，已保留原失败记录' })
    )
    expect(() =>
      buildSceneGenerationRepairContext(
        source,
        { ...sourceCheckpoint(source), unresolvedIssues: ['冲'.repeat(501)] },
        '改结尾'
      )
    ).toThrowError(
      expect.objectContaining({ code: 4103, message: '来源修复上下文过大，已保留原失败记录' })
    )
    expect(() =>
      buildSceneGenerationRepairContext(
        source,
        {
          ...sourceCheckpoint(source),
          unresolvedIssues: ['冲'.repeat(500)]
        },
        '改结尾'
      )
    ).not.toThrow()
  })

  it('身份缺失、操作或候选错配、指令为空时拒绝构造', () => {
    const source = sourceExecution()
    const checkpoint = sourceCheckpoint(source)
    expect(
      buildSceneGenerationRepairContext(
        { ...source, checkpointId: undefined },
        checkpoint,
        '改结尾'
      )
    ).toBeUndefined()
    expect(
      buildSceneGenerationRepairContext(
        { ...source, candidateSnapshotId: undefined },
        checkpoint,
        '改结尾'
      )
    ).toBeUndefined()
    expect(
      buildSceneGenerationRepairContext(
        source,
        {
          ...checkpoint,
          execution: { ...checkpoint.execution, operationId: 'other-operation' }
        },
        '改结尾'
      )
    ).toBeUndefined()
    expect(
      buildSceneGenerationRepairContext(
        source,
        { ...checkpoint, candidateSnapshotId: 'other-snapshot' },
        '改结尾'
      )
    ).toBeUndefined()
    expect(buildSceneGenerationRepairContext(source, checkpoint, '   ')).toBeUndefined()
  })
})

describe('repairContextIssue', () => {
  it('旧记录没有修复上下文时保持可继续，不补造', () => {
    expect(repairContextIssue(sourceExecution())).toBeUndefined()
  })

  it('缺少来源身份时返回固定文案', () => {
    const context = completeContext()
    const execution = { ...contextExecution(context), repairSource: undefined }
    expect(repairContextIssue(execution)).toBe('修复上下文缺少来源身份，不能继续本次修复')
  })

  it('来源身份与上下文不一致时返回固定文案', () => {
    const execution = contextExecution(completeContext())
    expect(
      repairContextIssue({
        ...execution,
        repairSource: { ...execution.repairSource!, threadId: 'other-thread' }
      })
    ).toBe('修复来源身份与上下文不一致，不能继续本次修复')
    expect(
      repairContextIssue({
        ...execution,
        repairSource: { ...execution.repairSource!, candidateSnapshotId: 'other-snapshot' }
      })
    ).toBe('修复来源身份与上下文不一致，不能继续本次修复')
  })

  it('指令或候选路径不完整时返回固定文案，且不泄露路径', () => {
    const emptyInstruction = contextExecution(completeContext({ instruction: '   ' }))
    expect(repairContextIssue(emptyInstruction)).toBe('修复来源上下文不完整，不能继续本次修复')
    const emptyPath = contextExecution(completeContext({ candidatePath: ' ' }))
    expect(repairContextIssue(emptyPath)).toBe('修复来源上下文不完整，不能继续本次修复')
    const otherPath = contextExecution(completeContext({ candidatePath: 'scenes/other/start.txt' }))
    expect(repairContextIssue(otherPath)).toBe('修复来源上下文不完整，不能继续本次修复')
    expect(repairContextIssue(otherPath)).not.toContain('scenes/other')
  })

  it('完整上下文通过身份校验', () => {
    expect(repairContextIssue(contextExecution(completeContext()))).toBeUndefined()
  })
})

describe('canRetryFailedSceneGenerationRepair', () => {
  const request = {
    projectId: 'project-1',
    sceneId: 'scene-1',
    sourceOperationId: 'operation-1',
    sourceThreadId: 'thread-1',
    sourceBranchId: 'branch-1',
    sourceCheckpointId: 'checkpoint-1',
    candidateSnapshotId: 'snapshot-1',
    instruction: '改结尾'
  }
  const base = {
    projectId: 'project-1',
    sceneId: 'scene-1',
    operationId: 'operation-1',
    threadId: 'thread-1',
    branchId: 'branch-1',
    state: 'failed',
    checkpointId: 'checkpoint-1',
    candidateSnapshotId: 'snapshot-1'
  }

  it('新重试由来源上下文指令满足，旧记录仍由确认回复满足', () => {
    expect(canRetryFailedSceneGenerationRepair({ ...base, replies: [] }, request)).toBe(false)
    expect(
      canRetryFailedSceneGenerationRepair(
        { ...base, replies: [], repairContext: { instruction: ' 改结尾 ' } },
        request
      )
    ).toBe(true)
    expect(
      canRetryFailedSceneGenerationRepair(
        { ...base, replies: [{ reply: { kind: 'revise', body: '改结尾' } }] },
        request
      )
    ).toBe(true)
    expect(
      canRetryFailedSceneGenerationRepair(
        { ...base, state: 'cancelled', replies: [], repairContext: { instruction: '改结尾' } },
        request
      )
    ).toBe(false)
  })
})
