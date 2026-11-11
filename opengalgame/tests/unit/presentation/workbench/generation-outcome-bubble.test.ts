import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import type { SceneGenerationRenderStatusVO } from '@application/scene-generation/vo/SceneGenerationRenderVO'
import { GenerationOutcomeBubble } from '@presentation/pages/workbench/drawer/generation/GenerationConversation'
import { generationRunViewOf } from '@presentation/pages/workbench/drawer/generation/generationRunView'

type FailureClass =
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

function status(
  overrides: Partial<SceneGenerationRenderStatusVO> = {}
): SceneGenerationRenderStatusVO {
  return {
    projectId: 'project-1',
    sceneId: 'scene-1',
    operationId: 'operation-1',
    threadId: 'thread-1',
    branchId: 'branch-1',
    checkpointId: 'checkpoint-1',
    state: 'failed',
    stage: 'failed',
    stageMessage: '本次生成未完成',
    attempt: 1,
    sequence: 9,
    canPause: false,
    canResume: false,
    canCancel: false,
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
    usage: { inputTokens: 1200, outputTokens: 3400, totalTokens: 4600, tokenLimit: null },
    previewAvailable: false,
    ...overrides
  }
}

function failedStatus(
  failureClass: FailureClass,
  overrides: Partial<SceneGenerationRenderStatusVO> = {}
): SceneGenerationRenderStatusVO {
  return status({
    failure: {
      code: 4101,
      message: '模型调用失败，本次生成未完成。',
      reason: 'modelFailure',
      failureClass,
      nextActions:
        failureClass === 'inputInvalid'
          ? ['returnToCanvas', 'viewInputSummary']
          : failureClass === 'blocked'
            ? ['reviseRequirement', 'returnToCanvas', 'discard']
            : ['retryOperation', 'viewCandidate'],
      reference: 'a1b2c3d4e5f6',
      unverified: false
    },
    ...overrides
  })
}

function renderOutcome(
  statusValue: SceneGenerationRenderStatusVO,
  handlers: Record<string, () => void> = {}
): string {
  const view = generationRunViewOf(statusValue)
  expect(view).not.toBeNull()
  return renderToStaticMarkup(
    createElement(GenerationOutcomeBubble, {
      view: view!,
      status: statusValue,
      pending: false,
      pendingAction: null,
      startBlockedReason: null,
      retryError: null,
      ...handlers
    })
  )
}

const baseHandlers = {
  onCancel: () => undefined,
  onOpenSummary: () => undefined,
  onRegenerate: () => undefined,
  onReload: () => undefined,
  onResume: () => undefined,
  onRetryRepair: () => undefined,
  onReturnToCanvas: () => undefined,
  onViewPreviousCandidate: () => undefined
}

function withPrevious(statusValue: SceneGenerationRenderStatusVO): SceneGenerationRenderStatusVO {
  return {
    ...statusValue,
    candidateSnapshotId: 'candidate-1',
    checkpointId: 'checkpoint-1',
    previewAvailable: true,
    previewAuthorization: 'readOnly'
  }
}

describe('失败气泡动作', () => {
  it('瞬时失败先按画布重新生成，不显示重试本次操作', () => {
    const html = renderOutcome(withPrevious(failedStatus('modelTransient')), baseHandlers)

    expect(html).toContain('按画布重新生成')
    expect(html).toContain('查看上一候选')
    expect(html).not.toContain('重试本次操作')
    expect(html).not.toContain('打开输入摘要')
  })

  it('鉴权失败给核对状态、输入摘要和真实可用的重新生成，不显示检查连接设置', () => {
    const html = renderOutcome(failedStatus('modelAuth'), baseHandlers)

    expect(html).toContain('重新核对任务状态')
    expect(html).toContain('打开输入摘要')
    expect(html).toContain('按画布重新生成')
    expect(html).not.toContain('检查连接设置')
  })

  it('要求被拒绝或输入过多时给输入摘要和重新生成，不伪造提交修改要求', () => {
    for (const failureClass of ['modelRejected', 'contextOverflow'] as const) {
      const html = renderOutcome(failedStatus(failureClass), baseHandlers)
      expect(html).toContain('打开输入摘要')
      expect(html).toContain('按画布重新生成')
      expect(html).not.toContain('提交修改要求')
    }
  })

  it('阻塞和修正用尽时仍保留真实可用的按画布重新生成', () => {
    for (const failureClass of ['blocked', 'correctionsExhausted'] as const) {
      const html = renderOutcome(failedStatus(failureClass), baseHandlers)
      expect(html).toContain('按画布重新生成')
      expect(html).not.toContain('当前没有可用的页面动作')
      expect(html).not.toContain('提交修改要求')
    }
  })

  it('输出契约先查看候选，再按画布重新生成', () => {
    const html = renderOutcome(withPrevious(failedStatus('outputContract')), baseHandlers)
    expect(html).toContain('查看上一候选')
    expect(html).toContain('按画布重新生成')
  })

  it('没有进展时修复重试排第一，并保留上一候选和重新生成', () => {
    const repair = failedStatus('noProgress', {
      mode: 'repair',
      repairSource: {
        operationId: 'source-operation',
        threadId: 'source-thread',
        branchId: 'source-branch',
        checkpointId: 'source-checkpoint',
        candidateSnapshotId: 'source-candidate'
      },
      candidateSnapshotId: 'failed-candidate',
      checkpointId: 'failed-checkpoint',
      previewAvailable: true,
      previewAuthorization: 'readOnly',
      userMessages: [{ kind: 'revise', body: '把相认放到结尾', round: 2 }]
    })
    const html = renderOutcome(repair, baseHandlers)

    expect(html).toContain('重试本次修改')
    expect(html).toContain('查看上一候选')
    expect(html).toContain('按画布重新生成')
  })

  it('输入无效时返回画布排第一，打开输入摘要和重新生成仍可用', () => {
    const html = renderOutcome(failedStatus('inputInvalid'), baseHandlers)

    expect(html).toContain('返回画布')
    expect(html).toContain('打开输入摘要')
    expect(html).toContain('按画布重新生成')
  })

  it('结果待核对时先核对任务状态，不显示重新生成', () => {
    const html = renderOutcome(
      status({
        state: 'interrupted',
        stage: 'failed',
        canCancel: false,
        failure: {
          code: 4101,
          message: '提交结果待核对',
          unverified: true,
          failureClass: 'modelTransient',
          nextActions: ['verifyTask'],
          reference: 'c0a17b93e52d'
        }
      }),
      baseHandlers
    )

    expect(html).toContain('核对任务状态')
    expect(html).toContain('结果待核对')
    expect(html).not.toContain('按画布重新生成')
  })

  it('暂停时给继续生成和结束本次生成，取消时给上一候选和重新生成', () => {
    const paused = renderOutcome(
      status({
        state: 'interrupted',
        stage: 'paused',
        canResume: true,
        canCancel: true
      }),
      baseHandlers
    )
    expect(paused).toContain('继续生成')
    expect(paused).toContain('结束本次生成')
    expect(paused).not.toContain('诊断信息')

    const cancelled = renderOutcome(
      status({
        state: 'cancelled',
        stage: 'cancelled',
        candidateSnapshotId: 'candidate-1',
        previewAvailable: true,
        previewAuthorization: 'readOnly'
      }),
      baseHandlers
    )
    expect(cancelled).toContain('查看上一候选')
    expect(cancelled).toContain('重新生成')
    expect(cancelled).toContain('打开输入摘要')
    expect(cancelled).not.toContain('诊断信息')
  })

  it('没有真实回调时不渲染对应动作', () => {
    const html = renderOutcome(withPrevious(failedStatus('modelTransient')), {
      onRegenerate: () => undefined
    })

    expect(html).toContain('按画布重新生成')
    expect(html).not.toContain('查看上一候选')
    expect(html).not.toContain('打开输入摘要')
    expect(html).not.toContain('核对任务状态')
  })

  it('旧壳缺少摘要和返回画布回调时，阻塞失败只显示真实的重新生成', () => {
    const html = renderOutcome(failedStatus('blocked'), { onRegenerate: () => undefined })

    expect(html).toContain('按画布重新生成')
    expect(html).not.toContain('返回画布')
    expect(html).not.toContain('打开输入摘要')
    expect(html).not.toContain('提交修改要求')
    expect(html).not.toContain('当前没有可用的页面动作')
  })

  it('鉴权和输入过多失败在回调不全时仍至少保留一个真实动作', () => {
    for (const failureClass of ['modelAuth', 'contextOverflow'] as const) {
      const html = renderOutcome(failedStatus(failureClass), {
        onRegenerate: () => undefined
      })
      expect(html).toContain('按画布重新生成')
      expect(html).not.toContain('当前没有可用的页面动作')
    }
  })
})

describe('失败气泡诊断', () => {
  it('显示故障指纹和操作时间，缺失时不补造', () => {
    const withReference = renderOutcome(
      failedStatus('modelTransient', { updatedAt: '2026-11-04T12:34:56.789Z' }),
      baseHandlers
    )
    expect(withReference).toContain('诊断信息')
    expect(withReference).toContain('故障指纹')
    expect(withReference).toContain('a1b2c3d4e5f6')
    expect(withReference).toContain('操作时间')
    expect(withReference).toContain('2026年11月4日')

    const missing = renderOutcome(
      status({
        failure: {
          code: 4101,
          message: '模型调用失败，本次生成未完成。',
          legacy: true
        }
      }),
      baseHandlers
    )
    expect(missing).toContain('没有可用的诊断编号')
    expect(missing).toContain('没有可用的操作时间')
  })

  it('不显示后端状态名、错误码、路径或内部字段名', () => {
    const html = renderOutcome(failedStatus('modelTransient'), baseHandlers)
    for (const text of ['modelTransient', '4101', 'nextActions', 'failureClass', 'C:\\\\']) {
      expect(html).not.toContain(text)
    }
  })
})
