import { describe, expect, it } from 'vitest'

import type { SceneGenerationRenderStatusVO } from '@application/scene-generation/vo/SceneGenerationRenderVO'
import {
  generationRunActionsOf,
  generationRunViewOf
} from '@presentation/pages/workbench/drawer/generation/generationRunView'

function status(
  overrides: Partial<SceneGenerationRenderStatusVO> = {}
): SceneGenerationRenderStatusVO {
  return {
    projectId: 'project-1',
    sceneId: 'scene-1',
    operationId: 'operation-1',
    threadId: 'thread-1',
    branchId: 'branch-1',
    state: 'running',
    stage: 'generating',
    stageMessage: 'AI 正在生成候选脚本',
    attempt: 1,
    sequence: 7,
    canPause: true,
    canResume: false,
    canCancel: true,
    inputSummary: {
      canvasId: 'canvas-1',
      arrangementVersion: 'saved-version',
      documentCount: 1,
      assetCount: 2,
      promptCount: 1,
      fieldBindingCount: 0,
      relationCount: 0,
      confirmedControlCount: 0
    },
    usage: { inputTokens: 11, outputTokens: 7, totalTokens: 18, tokenLimit: null },
    previewAvailable: false,
    ...overrides
  }
}

describe('generationRunViewOf', () => {
  it('把新记录收敛为单一运行视图，进度优先取最近安全进度', () => {
    const recentProgress = [
      {
        sequence: 5,
        createdAt: '2026-11-04T12:00:05.000Z',
        stage: 'readingInput' as const,
        message: '正在读取已保存编排与输入'
      },
      {
        sequence: 6,
        createdAt: '2026-11-04T12:00:06.000Z',
        stage: 'generating' as const,
        message: 'AI 正在生成候选脚本'
      }
    ]
    const view = generationRunViewOf(
      status({
        recentProgress,
        activity: { kind: 'tool', lastActivityAt: '2026-11-04T12:00:07.000Z' }
      }),
      [{ sequence: 1, stage: 'readingInput', message: '内存进度' }]
    )
    expect(view).toMatchObject({
      runState: 'running',
      phase: 'running',
      stage: 'generating',
      stageMessage: 'AI 正在生成候选脚本',
      failure: null,
      readLedger: null,
      progress: recentProgress,
      activity: { kind: 'tool', lastActivityAt: '2026-11-04T12:00:07.000Z' },
      interaction: null,
      canCancel: true,
      legacy: false,
      resume: { canResume: false, reason: null }
    })
    expect(view?.progress).toBe(recentProgress)
    expect(view?.candidate).toEqual({
      candidateSnapshotId: null,
      previewAuthorization: null,
      available: false,
      canOpen: false,
      previous: false,
      previousNote: null
    })
    expect(view?.validation).toEqual({ knownIssues: [], ok: false })
    expect(generationRunActionsOf(view!)).toEqual(['cancel'])
  })

  it('素材增强问题透传到运行视图，审阅仍只按安全文案展示', () => {
    const knownIssues = [
      {
        code: 'missing-asset',
        message: '候选引用的素材不存在',
        correctable: true,
        requiresHumanDecision: false,
        reference: 'bg 云还没有走',
        line: 12,
        nearestReference: 'bg 教室',
        nearestAssetName: '教室'
      }
    ] as const
    const view = generationRunViewOf(
      status({ knownIssues, previewAvailable: false })
    )
    expect(view?.validation.knownIssues).toBe(knownIssues)
    expect(view?.validation.knownIssues[0]?.message).toBe('候选引用的素材不存在')
    expect(view?.validation.ok).toBe(false)
  })

  it('没有执行时间线时回退本次会话收到过的进度', () => {
    const progress = [
      { sequence: 1, stage: 'readingInput' as const, message: '正在读取已保存编排与输入' }
    ]
    const view = generationRunViewOf(status(), progress)
    expect(view?.progress).toBe(progress)
  })

  it('旧失败记录保持缺失分类和动作，只标旧记录', () => {
    const view = generationRunViewOf(
      status({
        state: 'failed',
        stage: 'failed',
        stageMessage: '本次生成未完成',
        canPause: false,
        canCancel: false,
        failure: {
          code: 4101,
          message: '模型连接中断，本次生成未完成。',
          unverified: false,
          legacy: true
        }
      })
    )
    expect(view?.phase).toBe('failed')
    expect(view?.failure).toMatchObject({
      title: '生成没有完成',
      message: '模型连接中断，本次生成未完成。',
      failureClass: null,
      nextActions: [],
      legacy: true,
      canRetryRepair: false
    })
    expect(view?.legacy).toBe(true)
    expect(view?.failureClass).toBeNull()
    expect(view?.nextActions).toEqual([])
    expect(generationRunActionsOf(view!)).toEqual(['regenerate', 'reload', 'open-summary'])
  })

  it('失败分类和下一步动作保留原始安全事实，页面只映射真实可用动作', () => {
    const view = generationRunViewOf(
      status({
        state: 'failed',
        stage: 'failed',
        stageMessage: '本次生成未完成',
        canPause: false,
        canCancel: false,
        checkpointId: 'checkpoint-1',
        candidateSnapshotId: 'candidate-1',
        previewAvailable: true,
        previewAuthorization: 'readOnly',
        failure: {
          code: 4101,
          message: '模型调用失败，本次生成未完成',
          reason: 'modelFailure',
          failureClass: 'modelTransient',
          nextActions: ['retryOperation', 'viewCandidate'],
          reference: '0123456789ab',
          unverified: false,
          legacy: false
        }
      })
    )
    expect(view?.failure).toMatchObject({
      failureClass: 'modelTransient',
      nextActions: ['retryOperation', 'viewCandidate'],
      legacy: false
    })
    expect(view?.failureClass).toBe('modelTransient')
    expect(view?.nextActions).toEqual(['retryOperation', 'viewCandidate'])
    expect(view?.candidate).toMatchObject({
      candidateSnapshotId: 'candidate-1',
      previewAuthorization: 'readOnly',
      available: true,
      canOpen: true,
      previous: true
    })
    const actions = generationRunActionsOf(view!)
    expect(actions).toEqual(['view-previous-candidate', 'regenerate', 'reload', 'open-summary'])
    // 同操作重试和连接检查当前没有公开客户端能力，不能出现在页面动作里。
    expect(actions.join('|')).not.toContain('retryOperation')
    expect(actions.join('|')).not.toContain('checkConnection')
  })

  it('旧记录缺失败分类时按失败原因桥接分类和下一步动作', () => {
    const view = generationRunViewOf(
      status({
        state: 'failed',
        stage: 'failed',
        stageMessage: '本次生成未完成',
        canPause: false,
        canCancel: false,
        failure: {
          code: 4101,
          message: '模型调用失败，本次生成未完成',
          reason: 'modelFailure',
          unverified: false,
          legacy: true
        }
      })
    )

    expect(view?.failureClass).toBe('modelTransient')
    expect(view?.nextActions).toEqual(['retryOperation', 'viewCandidate'])
    expect(view?.failure?.title).toBe('模型暂时不可用')
    expect(view?.legacy).toBe(true)
  })

  it('失败候选缺检查点时不能打开或查看，并说明真实原因', () => {
    const view = generationRunViewOf(
      status({
        state: 'failed',
        stage: 'failed',
        stageMessage: '本次生成未完成',
        canPause: false,
        canCancel: false,
        candidateSnapshotId: 'candidate-1',
        previewAvailable: true,
        previewAuthorization: 'readOnly',
        failure: {
          code: 4101,
          message: '模型调用失败，本次生成未完成',
          reason: 'modelFailure',
          failureClass: 'modelTransient',
          nextActions: ['viewCandidate'],
          unverified: false,
          legacy: false
        }
      })
    )
    expect(view?.candidate).toMatchObject({
      candidateSnapshotId: 'candidate-1',
      previewAuthorization: 'readOnly',
      available: true,
      canOpen: false,
      previous: false,
      previousNote: '上一候选缺少可查看的检查点，暂时不能查看。'
    })
    expect(generationRunActionsOf(view!)).toEqual(['regenerate', 'reload', 'open-summary'])
  })

  it('只有修复失败且身份完整时提供重试本次修改', () => {
    const view = generationRunViewOf(
      status({
        state: 'failed',
        stage: 'failed',
        stageMessage: '本次生成未完成',
        canPause: false,
        canCancel: false,
        checkpointId: 'checkpoint-1',
        candidateSnapshotId: 'candidate-1',
        mode: 'repair',
        repairSource: {
          operationId: 'source-operation',
          threadId: 'source-thread',
          branchId: 'source-branch',
          checkpointId: 'source-checkpoint',
          candidateSnapshotId: 'previous-candidate'
        },
        userMessages: [{ kind: 'revise', body: '只保留站台的对白', round: 1 }],
        failure: {
          code: 4101,
          message: '模型调用失败，本次生成未完成',
          reason: 'modelFailure',
          failureClass: 'modelTransient',
          nextActions: ['retryOperation', 'viewCandidate'],
          unverified: false,
          legacy: false
        }
      })
    )
    expect(view?.failure?.canRetryRepair).toBe(true)
    expect(generationRunActionsOf(view!)).toEqual([
      'retry-repair',
      'regenerate',
      'reload',
      'open-summary'
    ])
  })

  it('输入无效或阻塞的失败按记录动作提供返回画布', () => {
    const cases = [
      ['inputInvalid', ['returnToCanvas', 'viewInputSummary']],
      ['blocked', ['reviseRequirement', 'returnToCanvas', 'discard']]
    ] as const
    for (const [failureClass, nextActions] of cases) {
      const view = generationRunViewOf(
        status({
          state: 'failed',
          stage: 'failed',
          stageMessage: '本次生成未完成',
          canPause: false,
          canCancel: false,
          failure: {
            code: 4101,
            message: '输入或要求不能继续生成',
            failureClass,
            nextActions,
            unverified: false,
            legacy: false
          }
        })
      )
      expect(view?.failure?.failureClass).toBe(failureClass)
      expect(view?.failure?.nextActions).toEqual(nextActions)
      expect(generationRunActionsOf(view!)).toEqual([
        'regenerate',
        'return-to-canvas',
        'reload',
        'open-summary'
      ])
    }
  })

  it('待核对中断有只读候选时提供上一候选，不提供重新生成', () => {
    const view = generationRunViewOf(
      status({
        state: 'interrupted',
        stage: 'failed',
        stageMessage: '提交结果待核对',
        canPause: false,
        canCancel: true,
        checkpointId: 'checkpoint-1',
        candidateSnapshotId: 'candidate-1',
        previewAvailable: true,
        previewAuthorization: 'readOnly',
        failure: {
          code: 4101,
          message: '提交结果待核对',
          failureClass: 'modelTransient',
          nextActions: ['retryOperation', 'viewCandidate'],
          reference: '0123456789ab',
          unverified: true,
          legacy: false
        }
      })
    )
    expect(view?.phase).toBe('failed')
    expect(view?.candidate).toMatchObject({
      previous: true,
      previousNote: '只能只读查看，不能接受或修改。',
      canOpen: true
    })
    expect(generationRunActionsOf(view!)).toEqual([
      'view-previous-candidate',
      'reload',
      'open-summary'
    ])
  })

  it('暂停不授予只读候选，提供继续生成和结束本次生成', () => {
    const view = generationRunViewOf(
      status({
        state: 'interrupted',
        stage: 'paused',
        stageMessage: '已暂停，可继续',
        canPause: false,
        canResume: true,
        canCancel: true,
        checkpointId: 'checkpoint-1',
        candidateSnapshotId: 'candidate-1',
        previewAvailable: true
      })
    )
    expect(view?.phase).toBe('paused')
    expect(view?.candidate.previous).toBe(false)
    expect(view?.candidate.canOpen).toBe(false)
    expect(view?.canCancel).toBe(true)
    expect(generationRunActionsOf(view!)).toEqual(['resume', 'cancel'])
  })

  it('取消后没有只读授权时不伪造上一候选', () => {
    const view = generationRunViewOf(
      status({
        state: 'cancelled',
        stage: 'cancelled',
        stageMessage: '本次生成已取消',
        canPause: false,
        canCancel: false,
        candidateSnapshotId: 'candidate-1',
        previewAvailable: true
      })
    )
    expect(view?.candidate.previous).toBe(false)
    expect(view?.candidate.canOpen).toBe(false)
    expect(generationRunActionsOf(view!)).toEqual(['regenerate', 'open-summary'])
  })

  it('审阅交互与当前状态的候选身份一致时才允许打开候选', () => {
    const interaction = {
      interactionId: 'interaction-1',
      checkpointId: 'checkpoint-1',
      kind: 'review' as const,
      message: '请审阅当前候选',
      options: [],
      allowedReplies: ['accept', 'revise', 'discard'] as const,
      candidateSnapshotId: 'candidate-1'
    }
    const matching = generationRunViewOf(
      status({
        state: 'waiting',
        stage: 'waitingReview',
        stageMessage: '候选已就绪，等待你的决定',
        canPause: false,
        checkpointId: 'checkpoint-1',
        candidateSnapshotId: 'candidate-1',
        previewAvailable: true,
        interaction
      })
    )
    expect(matching?.candidate.canOpen).toBe(true)

    const stale = generationRunViewOf(
      status({
        state: 'waiting',
        stage: 'waitingReview',
        stageMessage: '候选已就绪，等待你的决定',
        canPause: false,
        checkpointId: 'checkpoint-2',
        candidateSnapshotId: 'candidate-2',
        previewAvailable: true,
        interaction
      })
    )
    expect(stale?.candidate.canOpen).toBe(false)
  })

  it('等待修正时提供提交修改要求，运行中只提供取消', () => {
    const waiting = generationRunViewOf(
      status({
        state: 'waiting',
        stage: 'waitingReview',
        stageMessage: '候选已就绪，等待你的决定',
        canPause: false,
        canCancel: true,
        interaction: {
          interactionId: 'interaction-1',
          checkpointId: 'checkpoint-1',
          kind: 'correction',
          message: '请提交修改要求',
          options: [],
          allowedReplies: ['revise', 'discard']
        }
      })
    )
    expect(generationRunActionsOf(waiting!)).toEqual(['submit-revision', 'cancel'])

    const running = generationRunViewOf(status())
    expect(generationRunActionsOf(running!)).toEqual(['cancel'])
  })

  it('已提交后仍可发起按画布重新生成', () => {
    const view = generationRunViewOf(
      status({
        state: 'succeeded',
        stage: 'completed',
        stageMessage: '这一场已经写入作品',
        canPause: false,
        canCancel: false
      })
    )
    expect(view?.phase).toBe('completed')
    expect(generationRunActionsOf(view!)).toEqual(['regenerate'])
  })

  it('没有当前操作时返回 null', () => {
    expect(generationRunViewOf(null)).toBeNull()
  })
})
