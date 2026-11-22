import { describe, expect, it } from 'vitest'

import type { SceneGenerationRenderStatusVO } from '@application/scene-generation/vo/SceneGenerationRenderVO'
import {
  cleanupRetryRequestOf,
  unfinishedResumeRequestOf,
  unknownVerificationRequestOf
} from '@presentation/pages/workbench/drawer/generation/generationPresentation'
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

const scope = { projectId: 'project-1', sceneId: 'scene-1' }

describe('无检查点恢复与提交后清理动作', () => {
  it('只有显式可恢复的无检查点状态才生成恢复请求和动作', () => {
    const recoverable = status({ canResumeUnfinished: true, checkpointId: undefined })
    expect(unfinishedResumeRequestOf(recoverable, scope)).toEqual({
      projectId: 'project-1',
      sceneId: 'scene-1',
      operationId: 'operation-1',
      threadId: 'thread-1',
      branchId: 'branch-1'
    })
    const view = generationRunViewOf(recoverable)
    expect(view?.canResumeUnfinished).toBe(true)
    expect(generationRunActionsOf(view!)).toContain('resume-unfinished')

    expect(
      unfinishedResumeRequestOf({ ...recoverable, canResumeUnfinished: false }, scope)
    ).toBeNull()
    expect(
      unfinishedResumeRequestOf({ ...recoverable, checkpointId: 'checkpoint-1' }, scope)
    ).toBeNull()
    expect(unfinishedResumeRequestOf({ ...recoverable, projectId: 'project-2' }, scope)).toBeNull()
    expect(unfinishedResumeRequestOf({ ...recoverable, state: 'waiting' }, scope)).toBeNull()
  })

  it('只有后端标记可核对时才生成核对请求和动作', () => {
    const verify = status({
      state: 'interrupted',
      stage: 'failed',
      canVerifyResult: true,
      canCancel: false,
      failure: {
        code: 4101,
        message: '候选写入结果待核对',
        unverified: true
      }
    })
    expect(unknownVerificationRequestOf(verify, scope)).toEqual({
      projectId: 'project-1',
      sceneId: 'scene-1',
      operationId: 'operation-1',
      threadId: 'thread-1',
      branchId: 'branch-1'
    })
    const view = generationRunViewOf(verify)
    expect(view?.canVerifyResult).toBe(true)
    expect(generationRunActionsOf(view!)).toContain('verify-result')

    expect(
      unknownVerificationRequestOf({ ...verify, canVerifyResult: false }, scope)
    ).toBeNull()
    expect(unknownVerificationRequestOf({ ...verify, state: 'waiting' }, scope)).toBeNull()
    expect(unknownVerificationRequestOf({ ...verify, projectId: 'project-2' }, scope)).toBeNull()
  })

  it('只有已提交且登记了清理待处理事实时才生成清理请求和动作', () => {
    const cleanup = status({
      state: 'succeeded',
      stage: 'completed',
      cleanupPending: true,
      canRetryCleanup: true,
      canCancel: false
    })
    expect(cleanupRetryRequestOf(cleanup, scope)).toEqual({
      projectId: 'project-1',
      sceneId: 'scene-1',
      operationId: 'operation-1',
      threadId: 'thread-1',
      branchId: 'branch-1'
    })
    const view = generationRunViewOf(cleanup)
    expect(view?.canRetryCleanup).toBe(true)
    expect(generationRunActionsOf(view!)).toContain('retry-cleanup')

    expect(cleanupRetryRequestOf({ ...cleanup, cleanupPending: false }, scope)).toBeNull()
    expect(cleanupRetryRequestOf({ ...cleanup, canRetryCleanup: false }, scope)).toBeNull()
    expect(cleanupRetryRequestOf({ ...cleanup, state: 'failed' }, scope)).toBeNull()
    expect(cleanupRetryRequestOf({ ...cleanup, projectId: 'project-2' }, scope)).toBeNull()
  })
})
