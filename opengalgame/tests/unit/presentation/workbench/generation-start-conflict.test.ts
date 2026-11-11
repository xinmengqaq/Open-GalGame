import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { SCENE_GENERATION_START_CONFLICT_MESSAGE } from '@application/scene-generation/policies/SceneGenerationStartConflict'
import type { SceneGenerationRenderStatusVO } from '@application/scene-generation/vo/SceneGenerationRenderVO'
import { GenerationConversation } from '@presentation/pages/workbench/drawer/generation/GenerationConversation'
import {
  emptyDraft,
  type GenerationActionFailure
} from '@presentation/pages/workbench/drawer/generation/generationPresentation'

const conflictFailure: GenerationActionFailure = {
  kind: 'start',
  message: SCENE_GENERATION_START_CONFLICT_MESSAGE,
  unverified: false,
  code: 4103
}

function status(): SceneGenerationRenderStatusVO {
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
    previewAvailable: false
  }
}

function renderConversation(
  renderStatus: SceneGenerationRenderStatusVO | null,
  actionError: GenerationActionFailure | null
): string {
  return renderToStaticMarkup(
    createElement(GenerationConversation, {
      status: renderStatus,
      progress: [],
      draft: emptyDraft,
      pending: false,
      pendingAction: null,
      actionError,
      loading: false,
      loadError: null,
      projectName: '测试项目',
      sceneLabel: '测试场景',
      startBlockedReason: null,
      startPhase: null,
      reviseOpen: false,
      onStart: () => undefined,
      onOpenSummary: () => undefined,
      onOpenHistory: () => undefined,
      onReturnToCanvas: () => undefined,
      onReload: () => undefined,
      onResume: () => undefined,
      onRetryRepair: () => undefined,
      onCancel: () => undefined,
      onOpenWorks: () => undefined,
      onOpenRevise: () => undefined,
      onSelectOption: () => undefined,
      onSelectAnswer: () => undefined,
      onAnswerBodyChange: () => undefined,
      onBodyChange: () => undefined,
      onSubmitPrimary: () => undefined,
      onAccept: () => undefined,
      onDiscard: () => undefined
    })
  )
}

describe('GenerationConversation 启动冲突提示', () => {
  it('非空态也显示启动冲突错误，并与应用层文案一致', () => {
    const html = renderConversation(status(), conflictFailure)

    expect(html).toContain('按已保存编排生成本场景。')
    expect(html).toContain('wb-gen-outcome__error')
    expect(html).toContain('role="alert"')
    expect(html).toContain(SCENE_GENERATION_START_CONFLICT_MESSAGE)
  })

  it('非空态没有启动错误时不渲染冲突提示', () => {
    const html = renderConversation(status(), null)

    expect(html).not.toContain('wb-gen-outcome__error')
    expect(html).not.toContain(SCENE_GENERATION_START_CONFLICT_MESSAGE)
  })

  it('空态继续使用原有错误样式显示启动冲突', () => {
    const html = renderConversation(null, conflictFailure)

    expect(html).toContain('wb-gen-empty__failure')
    expect(html).toContain('role="alert"')
    expect(html).toContain(SCENE_GENERATION_START_CONFLICT_MESSAGE)
    expect(html).not.toContain('wb-gen-outcome__error')
  })
})
