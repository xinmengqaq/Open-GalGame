// @vitest-environment jsdom

import { act, createElement, type ReactElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { SceneContentBasisVO } from '@application/scene-preview/vo/ScenePreviewSessionVO'
import { ErrorCodes } from '@common/errors/ErrorCodes'
import type { ScenePreviewClient } from '@interfaces/scene-preview/client/ScenePreviewClient'
import {
  usePreviewSaveSettlement,
  type UsePreviewSaveSettlementResult
} from '@presentation/pages/preview/usePreviewSaveSettlement'
import type { UsePreviewDraftEditingResult } from '@presentation/pages/preview/usePreviewDraftEditing'
import type { UsePreviewSessionLifecycleResult } from '@presentation/pages/preview/usePreviewSessionLifecycle'
import type { UseScenePreviewStageResult } from '@presentation/pages/preview/useScenePreviewStage'

type UsePreviewSaveSettlementOptions = Parameters<typeof usePreviewSaveSettlement>[0]

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

const basis: SceneContentBasisVO = {
  digest: 'content-digest',
  parserVersion: '4.6.5',
  engineVersion: '4.6.5'
}

function draftStub(options: { dirty?: boolean; selected?: string | null } = {}) {
  return {
    commitSaved: vi.fn(),
    closeEditingState: vi.fn(),
    finishEditing: vi.fn(),
    selectedRef: { current: options.selected ?? null },
    baselineRef: { current: options.dirty ? { 'd-1': '旧句' } : {} },
    draftsRef: { current: options.dirty ? { 'd-1': '新句' } : {} }
  } as unknown as UsePreviewDraftEditingResult
}

function lifecycleStub() {
  return {
    sessionRef: { current: { previewSessionId: 'preview-1' } },
    basisRef: { current: basis },
    lockRef: { current: 'editable' as const },
    replaceBasis: vi.fn(),
    markLocked: vi.fn()
  } as unknown as UsePreviewSessionLifecycleResult
}

function stageStub() {
  return {
    waitForIdle: vi.fn(async () => undefined),
    flushDraft: vi.fn(),
    adoptRuntimeGeneration: vi.fn(),
    acknowledgeSaved: vi.fn(),
    applyPreviewUpdate: vi.fn(),
    showSettlementSyncNotice: vi.fn(),
    clearPreviewUpdateNotice: vi.fn()
  } as unknown as UseScenePreviewStageResult
}

function clientStub() {
  const saveDialogueChanges = vi.fn()
  const readDialogueSaveSettlement = vi.fn()
  return {
    saveDialogueChanges,
    readDialogueSaveSettlement,
    client: {
      saveDialogueChanges,
      readDialogueSaveSettlement
    } as unknown as ScenePreviewClient
  }
}

function Probe({
  options,
  expose
}: {
  options: UsePreviewSaveSettlementOptions
  expose: (result: UsePreviewSaveSettlementResult) => void
}): ReactElement | null {
  expose(usePreviewSaveSettlement(options))
  return null
}

function render(
  client: ScenePreviewClient,
  draft: UsePreviewDraftEditingResult,
  callbacks: Partial<UsePreviewSaveSettlementOptions> = {}
): {
  current: () => UsePreviewSaveSettlementResult
  unmount: () => void
} {
  const container = document.createElement('div')
  const root = createRoot(container)
  let result: UsePreviewSaveSettlementResult | null = null
  const options: UsePreviewSaveSettlementOptions = {
    client,
    projectId: 'project-1',
    sceneId: 'scene-1',
    draft,
    lifecycle: lifecycleStub(),
    stage: stageStub(),
    saveInFlightRef: { current: false },
    ...callbacks
  }
  act(() => {
    root.render(
      createElement(Probe, {
        options,
        expose: (next) => {
          result = next
        }
      })
    )
  })
  return {
    current: () => {
      if (result === null) throw new Error('预计已渲染')
      return result
    },
    unmount: () => {
      act(() => root.unmount())
    }
  }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('预览保存结果拥有方', () => {
  it('没有真实改词时按无改动结算，不发保存开始或成功', async () => {
    const { client, saveDialogueChanges } = clientStub()
    const onSaveStarted = vi.fn()
    const onSaveCleared = vi.fn()
    const onSavedVersion = vi.fn()
    const view = render(client, draftStub(), { onSaveStarted, onSaveCleared, onSavedVersion })

    let outcome = ''
    await act(async () => {
      outcome = await view.current().save()
    })

    expect(outcome).toBe('unchanged')
    expect(saveDialogueChanges).not.toHaveBeenCalled()
    expect(onSaveStarted).not.toHaveBeenCalled()
    expect(onSavedVersion).not.toHaveBeenCalled()
    expect(onSaveCleared).toHaveBeenCalledWith({ reason: 'unchanged' })
    view.unmount()
  })

  it('明确失败后放弃未处理保存只发清除，不合成保存成功', async () => {
    const { client, saveDialogueChanges } = clientStub()
    saveDialogueChanges.mockResolvedValue({ code: 5000, msg: '保存失败' })
    const onSaveStarted = vi.fn()
    const onSaveUnsettled = vi.fn()
    const onSaveCleared = vi.fn()
    const onSavedVersion = vi.fn()
    const view = render(client, draftStub({ dirty: true, selected: 'd-1' }), {
      onSaveStarted,
      onSaveUnsettled,
      onSaveCleared,
      onSavedVersion
    })

    let outcome = ''
    await act(async () => {
      outcome = await view.current().save()
    })
    expect(outcome).toBe('rejected')
    const requestId = onSaveStarted.mock.calls[0]?.[0]?.requestId
    expect(requestId).toMatch(/\S/)
    expect(onSaveUnsettled).toHaveBeenCalledWith({
      outcome: 'failed',
      requestId
    })
    expect(onSavedVersion).not.toHaveBeenCalled()

    act(() => {
      view.current().abandonUnsettled()
    })
    expect(onSaveCleared).toHaveBeenCalledWith({ reason: 'abandoned', requestId })
    expect(onSavedVersion).not.toHaveBeenCalled()
    view.unmount()
  })

  it('没有发起保存就放弃草稿退出，也清除未保存状态', () => {
    const { client } = clientStub()
    const onSaveCleared = vi.fn()
    const onSavedVersion = vi.fn()
    const view = render(client, draftStub({ dirty: true }), { onSaveCleared, onSavedVersion })

    act(() => {
      view.current().abandonUnsettled(true)
    })
    expect(onSaveCleared).toHaveBeenCalledWith({ reason: 'abandoned' })
    expect(onSavedVersion).not.toHaveBeenCalled()
    view.unmount()
  })

  it('待核对后核对为无改动，按同一请求清除且不发保存成功', async () => {
    const { client, saveDialogueChanges, readDialogueSaveSettlement } = clientStub()
    saveDialogueChanges.mockResolvedValue({
      code: ErrorCodes.communicationFailed,
      msg: '通信中断'
    })
    readDialogueSaveSettlement.mockResolvedValue({
      code: ErrorCodes.success,
      msg: 'ok',
      data: { status: 'unchanged', contentBasis: basis, confirmedEdits: [] }
    })
    const onSaveStarted = vi.fn()
    const onSaveUnsettled = vi.fn()
    const onSaveCleared = vi.fn()
    const onSavedVersion = vi.fn()
    const view = render(client, draftStub({ dirty: true }), {
      onSaveStarted,
      onSaveUnsettled,
      onSaveCleared,
      onSavedVersion
    })

    let outcome = ''
    await act(async () => {
      outcome = await view.current().save()
    })
    expect(outcome).toBe('pending')
    const requestId = onSaveStarted.mock.calls[0]?.[0]?.requestId
    expect(onSaveUnsettled).toHaveBeenCalledWith({ outcome: 'unverified', requestId })

    await act(async () => {
      await view.current().checkSettlement()
    })
    expect(onSaveCleared).toHaveBeenCalledWith({ reason: 'unchanged', requestId })
    expect(onSavedVersion).not.toHaveBeenCalled()
    view.unmount()
  })
})
