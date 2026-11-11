import { describe, expect, it } from 'vitest'

import type { SceneGenerationRenderStatusVO } from '@application/scene-generation/vo/SceneGenerationRenderVO'
import { resumeRequestOf } from '@presentation/pages/workbench/drawer/generation/generationPresentation'

const scope = { projectId: 'project-1', sceneId: 'scene-1' }

function status(
  overrides: Partial<SceneGenerationRenderStatusVO> = {}
): SceneGenerationRenderStatusVO {
  return {
    projectId: 'project-1',
    sceneId: 'scene-1',
    operationId: 'operation-1',
    threadId: 'thread-1',
    branchId: 'branch-1',
    state: 'interrupted',
    stage: 'paused',
    stageMessage: '已暂停，可继续',
    attempt: 1,
    sequence: 4,
    canPause: false,
    canResume: true,
    canCancel: true,
    inputSummary: {
      canvasId: 'canvas-1',
      arrangementVersion: 'saved-version',
      documentCount: 1,
      assetCount: 0,
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

describe('生成恢复请求身份', () => {
  it('从当前状态组装操作、线程、分支、检查点和候选', () => {
    const current = status({
      checkpointId: 'checkpoint-current',
      candidateSnapshotId: 'snapshot-current'
    })

    expect(resumeRequestOf(current, scope)).toEqual({
      projectId: 'project-1',
      sceneId: 'scene-1',
      operationId: 'operation-1',
      threadId: 'thread-1',
      branchId: 'branch-1',
      checkpointId: 'checkpoint-current',
      candidateSnapshotId: 'snapshot-current'
    })
  })

  it('没有候选时不补候选字段', () => {
    const request = resumeRequestOf(status({ checkpointId: 'checkpoint-current' }), scope)

    expect(request).toEqual({
      projectId: 'project-1',
      sceneId: 'scene-1',
      operationId: 'operation-1',
      threadId: 'thread-1',
      branchId: 'branch-1',
      checkpointId: 'checkpoint-current'
    })
    expect(request).not.toHaveProperty('candidateSnapshotId')
  })

  it('缺状态或缺检查点时不产生请求', () => {
    expect(resumeRequestOf(null, scope)).toBeNull()
    expect(resumeRequestOf(status(), scope)).toBeNull()
    expect(resumeRequestOf(status({ checkpointId: '' }), scope)).toBeNull()
  })

  it('失败、取消或非暂停状态即使有检查点也不产生续跑请求', () => {
    expect(
      resumeRequestOf(
        status({ state: 'failed', stage: 'failed', checkpointId: 'checkpoint-1' }),
        scope
      )
    ).toBeNull()
    expect(
      resumeRequestOf(
        status({ state: 'cancelled', stage: 'cancelled', checkpointId: 'checkpoint-1' }),
        scope
      )
    ).toBeNull()
    expect(
      resumeRequestOf(
        status({ state: 'interrupted', stage: 'failed', checkpointId: 'checkpoint-1' }),
        scope
      )
    ).toBeNull()
  })

  it('旧检查点、旧候选或范围不一致时不产生请求', () => {
    expect(
      resumeRequestOf(
        status({
          checkpointId: 'checkpoint-current',
          interaction: {
            interactionId: 'interaction-1',
            checkpointId: 'checkpoint-old',
            kind: 'review',
            message: '等你审阅',
            options: [],
            allowedReplies: ['accept']
          }
        }),
        scope
      )
    ).toBeNull()
    expect(
      resumeRequestOf(
        status({
          checkpointId: 'checkpoint-current',
          candidateSnapshotId: 'snapshot-current',
          interaction: {
            interactionId: 'interaction-1',
            checkpointId: 'checkpoint-current',
            candidateSnapshotId: 'snapshot-old',
            kind: 'review',
            message: '等你审阅',
            options: [],
            allowedReplies: ['accept']
          }
        }),
        scope
      )
    ).toBeNull()
    expect(
      resumeRequestOf(status({ checkpointId: 'checkpoint-current', projectId: 'project-2' }), scope)
    ).toBeNull()
    expect(
      resumeRequestOf(status({ checkpointId: 'checkpoint-current', sceneId: 'scene-2' }), scope)
    ).toBeNull()
  })
})
