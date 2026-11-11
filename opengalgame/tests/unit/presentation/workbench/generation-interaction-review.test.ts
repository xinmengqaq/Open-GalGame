import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

import type {
  SceneGenerationRenderInteractionVO,
  SceneGenerationRenderStatusVO
} from '@application/scene-generation/vo/SceneGenerationRenderVO'
import type { CandidatePreviewVO } from '@application/scene-preview/vo/CandidatePreviewVO'
import {
  CandidatePreviewContext,
  type CandidatePreviewTabController
} from '@presentation/pages/workbench/drawer/candidate/candidatePreviewContext'
import {
  candidatePreviewPhaseOf,
  candidatePreviewReducer,
  initialCandidatePreviewState,
  type CandidatePreviewState
} from '@presentation/pages/workbench/drawer/candidate/candidatePreviewState'
import { GenerationInteraction } from '@presentation/pages/workbench/drawer/generation/GenerationInteraction'
import { emptyDraft } from '@presentation/pages/workbench/drawer/generation/generationPresentation'

const candidateSnapshotId = '0123456789abcdef'

function reviewInteraction(
  overrides: Partial<SceneGenerationRenderInteractionVO> = {}
): SceneGenerationRenderInteractionVO {
  return {
    interactionId: 'interaction-1',
    checkpointId: 'checkpoint-1',
    kind: 'review',
    message: '请审阅当前候选',
    options: [],
    allowedReplies: ['accept', 'revise', 'discard'],
    candidateSnapshotId,
    ...overrides
  }
}

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
    state: 'waiting',
    stage: 'waitingReview',
    stageMessage: '等待你审阅候选',
    attempt: 1,
    sequence: 12,
    canPause: false,
    canResume: false,
    canCancel: true,
    inputSummary: {
      canvasId: 'canvas-1',
      arrangementVersion: 'version-1',
      documentCount: 1,
      assetCount: 1,
      promptCount: 1,
      fieldBindingCount: 0,
      relationCount: 0,
      confirmedControlCount: 0
    },
    usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30, tokenLimit: null },
    candidateSnapshotId,
    previewAvailable: true,
    interaction: reviewInteraction(),
    ...overrides
  }
}

function preview(issues: CandidatePreviewVO['issues']): CandidatePreviewVO {
  return {
    projectId: 'project-1',
    sceneId: 'scene-1',
    sceneName: '雨夜重逢',
    readOnly: true,
    candidate: {
      previewSessionId: 'session-secret',
      candidateSnapshotId,
      expiresAt: '2026-10-26T12:15:00.000Z'
    },
    contentBasis: { digest: 'digest-1', parserVersion: 'parser-1', engineVersion: 'engine-1' },
    issues
  }
}

/** 已打开但尚未读取的候选会话。 */
function openedCandidateState(): CandidatePreviewState {
  const started = candidatePreviewReducer(initialCandidatePreviewState, {
    type: 'start',
    projectId: 'project-1',
    sceneId: 'scene-1',
    candidateSnapshotId
  })
  return candidatePreviewReducer(started, {
    type: 'opened',
    projectId: 'project-1',
    sceneId: 'scene-1',
    sessionId: 'session-secret',
    candidateSnapshotId,
    stageUrl: 'http://127.0.0.1:41000/?session=session-secret',
    expiresAt: Date.now() + 60_000
  })
}

/** 打开并读取完成的候选会话；不等舞台 ready，读取问题已经可用。 */
function readCandidateState(issues: CandidatePreviewVO['issues'] = []): CandidatePreviewState {
  return candidatePreviewReducer(
    candidatePreviewReducer(openedCandidateState(), { type: 'read-started' }),
    {
      type: 'read-succeeded',
      preview: preview(issues)
    }
  )
}

/** 已打开但读取失败的候选会话。 */
function readFailedCandidateState(): CandidatePreviewState {
  return candidatePreviewReducer(
    candidatePreviewReducer(openedCandidateState(), { type: 'read-started' }),
    { type: 'read-failed', message: '候选预览暂时不可用', sessionRejected: false }
  )
}

function controllerOf(state: CandidatePreviewState): CandidatePreviewTabController {
  return {
    state,
    phase: candidatePreviewPhaseOf(state),
    reloadStage: vi.fn(),
    reopen: vi.fn(),
    retryRead: vi.fn(),
    available: true,
    activate: vi.fn()
  }
}

function render(
  renderStatus: SceneGenerationRenderStatusVO,
  controller?: CandidatePreviewTabController
): string {
  const element = createElement(GenerationInteraction, {
    status: renderStatus,
    interaction: renderStatus.interaction ?? reviewInteraction(),
    draft: emptyDraft,
    pending: false,
    error: null,
    reviseOpen: false,
    onOpenRevise: vi.fn(),
    onSelectOption: vi.fn(),
    onSelectAnswer: vi.fn(),
    onAnswerBodyChange: vi.fn(),
    onBodyChange: vi.fn(),
    onSubmitPrimary: vi.fn(),
    onAccept: vi.fn(),
    onDiscard: vi.fn()
  })
  return renderToStaticMarkup(
    controller
      ? createElement(CandidatePreviewContext.Provider, { value: controller }, element)
      : element
  )
}

describe('GenerationInteraction 审阅气泡的候选事实', () => {
  it('候选可用时显示可用性、校验通过和打开入口，不放缩略图或第二预览面', () => {
    const html = render(status(), controllerOf(initialCandidatePreviewState))

    expect(html).toContain('候选可只读查看')
    expect(html).toContain('校验通过')
    expect(html).toContain('打开游戏候选')
    expect(html).toContain('打开只读游戏候选')
    expect(html).toContain('接受并提交')
    expect(html).toContain('提出修改')
    expect(html).toContain('丢弃候选')
    expect(html).not.toContain('<img')
    expect(html).not.toContain('<iframe')
    expect(html).not.toContain(candidateSnapshotId)
    expect(html).not.toContain('checkpoint-1')
  })

  it('校验问题用固定说明列出，与交互说明重复时不渲染两次，也不给假入口', () => {
    const issue = '候选引用的素材不存在'
    const html = render(
      status({
        previewAvailable: false,
        interaction: reviewInteraction({ message: `请审阅当前候选\n${issue}` }),
        knownIssues: [
          {
            code: 'missing-asset',
            message: issue,
            correctable: true,
            requiresHumanDecision: false
          }
        ]
      }),
      controllerOf(initialCandidatePreviewState)
    )

    expect(html).toContain('校验发现 1 条问题')
    expect(html).toContain('校验问题')
    expect(html).toContain('候选暂时不能只读查看')
    expect(html.split(issue)).toHaveLength(2)
    expect(html).not.toContain('打开游戏候选')
  })

  it('候选读取问题只在读取完成后显示，并与生成侧校验问题分开', () => {
    const state = readCandidateState([
      { message: '缺少背景素材', assetName: 'sora_01.jpg' },
      { message: '有一句旁白没有角色名' }
    ])
    const html = render(status(), controllerOf(state))

    expect(html).toContain('读取发现 2 个问题')
    expect(html).toContain('读取问题')
    expect(html).toContain('缺少背景素材')
    expect(html).toContain('sora_01.jpg')
    expect(html).toContain('有一句旁白没有角色名')
    expect(html).toContain('打开游戏候选')
    expect(html).not.toContain('session-secret')
    expect(html).not.toContain(candidateSnapshotId)
  })

  it('读取失败时状态胶囊与入口副文案分工，不重复同一句', () => {
    const html = render(status(), controllerOf(readFailedCandidateState()))

    expect(html).toContain('候选读取失败')
    expect(html).toContain('打开后可以重新读取')
    expect(html).not.toContain('读取失败，打开后可以重新读取')
    expect(html).toContain('打开游戏候选')
  })

  it('会话过期后不残留读取中或读取失败提示，已读问题仍保留', () => {
    const loadingExpired = candidatePreviewReducer(
      candidatePreviewReducer(openedCandidateState(), { type: 'read-started' }),
      { type: 'expire' }
    )
    const loadingHtml = render(status(), controllerOf(loadingExpired))
    expect(loadingHtml).not.toContain('正在读取候选')
    expect(loadingHtml).not.toContain('候选读取失败')
    expect(loadingHtml).not.toContain('打开后可以重新读取')
    expect(loadingHtml).toContain('运行会话已过期')

    const failedExpired = candidatePreviewReducer(
      candidatePreviewReducer(openedCandidateState(), {
        type: 'read-failed',
        message: '候选预览暂时不可用',
        sessionRejected: false
      }),
      { type: 'expire' }
    )
    const failedHtml = render(status(), controllerOf(failedExpired))
    expect(failedHtml).not.toContain('正在读取候选')
    expect(failedHtml).not.toContain('候选读取失败')
    expect(failedHtml).not.toContain('打开后可以重新读取')

    const readyExpired = candidatePreviewReducer(
      readCandidateState([{ message: '缺少背景素材', assetName: 'sora_01.jpg' }]),
      { type: 'expire' }
    )
    const readyHtml = render(status(), controllerOf(readyExpired))
    expect(readyHtml).toContain('读取发现 1 个问题')
    expect(readyHtml).toContain('缺少背景素材')
  })

  it('切换候选的同一帧不带出上一候选的读取问题，A 与 A 状态正常显示', () => {
    const candidateB = 'fedcba9876543210'
    const statusB = status({
      checkpointId: 'checkpoint-2',
      candidateSnapshotId: candidateB,
      interaction: reviewInteraction({
        checkpointId: 'checkpoint-2',
        candidateSnapshotId: candidateB
      })
    })
    const stateA = readCandidateState([
      { message: '缺少背景素材', assetName: 'sora_01.jpg' },
      { message: '有一句旁白没有角色名' }
    ])
    const htmlB = render(statusB, controllerOf(stateA))

    expect(htmlB).toContain('候选可只读查看')
    expect(htmlB).toContain('打开游戏候选')
    expect(htmlB).toContain('打开只读游戏候选')
    expect(htmlB).not.toContain('读取发现')
    expect(htmlB).not.toContain('读取问题')
    expect(htmlB).not.toContain('缺少背景素材')
    expect(htmlB).not.toContain('有一句旁白没有角色名')

    const htmlA = render(status(), controllerOf(stateA))
    expect(htmlA).toContain('读取发现 2 个问题')
    expect(htmlA).toContain('读取问题')
    expect(htmlA).toContain('缺少背景素材')
    expect(htmlA).toContain('有一句旁白没有角色名')
  })

  it('候选不可打开时不带出上一候选的读取结果', () => {
    const state = readCandidateState([{ message: '缺少背景素材', assetName: 'sora_01.jpg' }])
    const html = render(status({ previewAvailable: false }), controllerOf(state))

    expect(html).toContain('候选暂时不能只读查看')
    expect(html).not.toContain('读取发现')
    expect(html).not.toContain('缺少背景素材')
  })

  it('没有抽屉级候选会话时不渲染候选事实和入口，校验问题仍按真实状态显示', () => {
    const html = render(
      status({
        previewAvailable: false,
        knownIssues: [
          {
            code: 'missing-asset',
            message: '候选引用的素材不存在',
            correctable: true,
            requiresHumanDecision: false
          }
        ]
      })
    )

    expect(html).not.toContain('候选可只读查看')
    expect(html).not.toContain('候选暂时不能只读查看')
    expect(html).not.toContain('打开游戏候选')
    expect(html).toContain('校验问题')
    expect(html).toContain('候选引用的素材不存在')
  })
})

describe('GenerationInteraction 审阅的接受门槛', () => {
  it('降级候选不提供接受按钮，说明缺什么并保留修改和丢弃', () => {
    const html = render(
      status({
        interaction: reviewInteraction({
          message: '请审阅当前候选\n完成摘要未生成，请核对创作取舍'
        })
      })
    )

    expect(html).toContain('已生成候选，但这次没有提供完成说明。请先核对候选内容。')
    expect(html).toContain('完成说明缺失，候选不能直接接受。请提出修改，或丢弃候选后重新生成。')
    expect(html).not.toContain('接受并提交')
    expect(html).toContain('提出修改')
    expect(html).toContain('丢弃候选')
  })

  it('还有未解决可修正问题时不给接受，提示自动修正已用尽', () => {
    const html = render(
      status({
        previewAvailable: false,
        knownIssues: [
          {
            code: 'unknown-command',
            message: '候选含有当前解析器不能识别的命令',
            correctable: true,
            requiresHumanDecision: false
          }
        ]
      })
    )

    expect(html).toContain('自动修正已用尽，候选还有校验问题。请提出修改，或丢弃候选后重新生成。')
    expect(html).not.toContain('接受并提交')
    expect(html).toContain('提出修改')
    expect(html).toContain('丢弃候选')
  })
})
