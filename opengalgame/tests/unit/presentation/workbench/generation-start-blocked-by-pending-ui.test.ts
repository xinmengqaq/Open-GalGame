// @vitest-environment jsdom

import { act, createElement, type ReactElement } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it, vi } from 'vitest'

import type { SceneGenerationRenderStatusVO } from '@application/scene-generation/vo/SceneGenerationRenderVO'
import {
  GenerationCompletedBubble,
  GenerationOutcomeBubble
} from '@presentation/pages/workbench/drawer/generation/GenerationConversation'
import { generationRunViewOf } from '@presentation/pages/workbench/drawer/generation/generationRunView'

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const conflictReason =
  '当前场景已有进行中的生成，先完成或结束它（正在读取已保存编排与输入）；可在 AI 历史中处理已有任务。'

function terminalStatus(): SceneGenerationRenderStatusVO {
  return {
    projectId: 'project-1',
    sceneId: 'scene-1',
    operationId: 'operation-done',
    threadId: 'thread-1',
    branchId: 'branch-1',
    checkpointId: 'checkpoint-1',
    state: 'succeeded',
    stage: 'completed',
    stageMessage: '作品已提交',
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
    usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30, tokenLimit: null },
    previewAvailable: false,
    result: { commitId: 'commit-1' }
  }
}

function repairFailureStatus(): SceneGenerationRenderStatusVO {
  return {
    ...terminalStatus(),
    operationId: 'operation-failed',
    state: 'failed',
    stage: 'failed',
    stageMessage: '本次生成未完成',
    mode: 'repair',
    repairSource: {
      operationId: 'source-operation',
      threadId: 'source-thread',
      branchId: 'source-branch',
      checkpointId: 'source-checkpoint',
      candidateSnapshotId: 'source-candidate'
    },
    candidateSnapshotId: 'failed-candidate',
    previewAvailable: true,
    previewAuthorization: 'readOnly',
    userMessages: [{ kind: 'revise', body: '把相认放到结尾', round: 2 }],
    failure: {
      code: 4101,
      message: '模型调用失败，本次生成未完成。',
      reason: 'modelFailure',
      failureClass: 'noProgress',
      nextActions: ['retryOperation', 'viewCandidate'],
      reference: 'a1b2c3d4e5f6',
      unverified: false
    }
  }
}

function buttonByText(container: HTMLElement, text: string): HTMLButtonElement {
  const button = [...container.querySelectorAll('button')].find((candidate) =>
    candidate.textContent?.includes(text)
  )
  if (!(button instanceof HTMLButtonElement)) throw new Error(`没有找到按钮：${text}`)
  return button
}

async function mount(element: ReactElement): Promise<{
  container: HTMLElement
  unmount: () => Promise<void>
}> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  await act(async () => {
    root.render(element)
  })
  return {
    container,
    unmount: async () => {
      await act(async () => {
        root.unmount()
      })
      container.remove()
    }
  }
}

describe('历史中已有生成时的启动界面', () => {
  it('已提交终态显示真实原因与 AI 历史处理入口，重新生成保持禁用', async () => {
    const onOpenHistory = vi.fn()
    const mounted = await mount(
      createElement(GenerationCompletedBubble, {
        pending: false,
        startBlockedReason: conflictReason,
        startBlockedByGeneration: true,
        onOpenHistory,
        onOpenWorks: () => undefined,
        onStart: () => undefined
      })
    )
    try {
      expect(mounted.container.textContent).toContain(conflictReason)
      expect(buttonByText(mounted.container, '按画布重新生成').disabled).toBe(true)
      const history = buttonByText(mounted.container, '去 AI 历史处理')
      await act(async () => {
        history.click()
      })
      expect(onOpenHistory).toHaveBeenCalledTimes(1)
    } finally {
      await mounted.unmount()
    }
  })

  it('非生成冲突的禁用原因不冒充处理入口', async () => {
    const mounted = await mount(
      createElement(GenerationCompletedBubble, {
        pending: false,
        startBlockedReason: '画布有未保存的修改，先保存再开始生成。',
        startBlockedByGeneration: false,
        onOpenHistory: () => undefined,
        onOpenWorks: () => undefined,
        onStart: () => undefined
      })
    )
    try {
      expect(mounted.container.textContent).toContain('画布有未保存的修改')
      expect(mounted.container.textContent).not.toContain('去 AI 历史处理')
    } finally {
      await mounted.unmount()
    }
  })

  it('失败终态只禁普通重新生成，合法修复重试仍可打开确认且不被已有生成挡住', async () => {
    const status = repairFailureStatus()
    const view = generationRunViewOf(status)
    expect(view).not.toBeNull()
    const mounted = await mount(
      createElement(GenerationOutcomeBubble, {
        view: view!,
        status,
        pending: false,
        pendingAction: null,
        startBlockedReason: conflictReason,
        startBlockedByGeneration: true,
        repairBlockedReason: null,
        retryError: null,
        onOpenHistory: () => undefined,
        onCancel: () => undefined,
        onRetryRepair: () => undefined,
        onRegenerate: () => undefined,
        onReload: () => undefined,
        onResume: () => undefined,
        onReturnToCanvas: () => undefined,
        onVerifyResult: () => undefined,
        onViewPreviousCandidate: () => undefined,
        onOpenSummary: () => undefined
      })
    )
    try {
      expect(mounted.container.textContent).toContain(conflictReason)
      expect(buttonByText(mounted.container, '按画布重新生成').disabled).toBe(true)
      const repair = buttonByText(mounted.container, '重试本次修改')
      expect(repair.disabled).toBe(false)

      await act(async () => {
        repair.click()
      })
      expect(mounted.container.textContent).toContain('确认重试本次修改')
      expect(buttonByText(mounted.container, '确认重试本次修改').disabled).toBe(false)
    } finally {
      await mounted.unmount()
    }
  })

  it('修复自身的禁用原因仍然阻止修复确认', async () => {
    const status = repairFailureStatus()
    const view = generationRunViewOf(status)
    expect(view).not.toBeNull()
    const mounted = await mount(
      createElement(GenerationOutcomeBubble, {
        view: view!,
        status,
        pending: false,
        pendingAction: null,
        startBlockedReason: conflictReason,
        startBlockedByGeneration: true,
        repairBlockedReason: '画布有未保存的修改，先保存再生成。',
        retryError: null,
        onOpenHistory: () => undefined,
        onCancel: () => undefined,
        onRetryRepair: () => undefined,
        onRegenerate: () => undefined,
        onReload: () => undefined,
        onResume: () => undefined,
        onReturnToCanvas: () => undefined,
        onVerifyResult: () => undefined,
        onViewPreviousCandidate: () => undefined,
        onOpenSummary: () => undefined
      })
    )
    try {
      await act(async () => {
        buttonByText(mounted.container, '重试本次修改').click()
      })
      expect(mounted.container.textContent).toContain('画布有未保存的修改')
      expect(buttonByText(mounted.container, '确认重试本次修改').disabled).toBe(true)
    } finally {
      await mounted.unmount()
    }
  })
})
