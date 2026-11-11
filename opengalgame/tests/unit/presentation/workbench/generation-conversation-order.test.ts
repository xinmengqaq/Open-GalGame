import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

import type { SceneGenerationRenderStatusVO } from '@application/scene-generation/vo/SceneGenerationRenderVO'
import {
  GenerationConversation,
  GenerationStartRetry
} from '@presentation/pages/workbench/drawer/generation/GenerationConversation'
import { emptyDraft } from '@presentation/pages/workbench/drawer/generation/generationPresentation'

const initialBubbleText = '按已保存编排生成本场景。'
const runStripText = 'AI 正在生成候选脚本'

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
    stageMessage: runStripText,
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

function renderConversation(
  renderStatus: SceneGenerationRenderStatusVO,
  overrides: Partial<Parameters<typeof GenerationConversation>[0]> = {}
): string {
  return renderToStaticMarkup(
    createElement(GenerationConversation, {
      status: renderStatus,
      progress: [],
      draft: emptyDraft,
      pending: false,
      pendingAction: null,
      actionError: null,
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
      onDiscard: () => undefined,
      ...overrides
    })
  )
}

/** 取文案下标；缺文案时直接失败，避免 -1 < n 造成假通过。 */
function textIndex(html: string, text: string): number {
  const index = html.indexOf(text)
  expect(index, `渲染结果缺少文案：${text}`).toBeGreaterThanOrEqual(0)
  return index
}

describe('GenerationConversation 消息顺序', () => {
  it('修正轮运行时，用户的修改要求排在进度卡之前', () => {
    const html = renderConversation(
      status({
        state: 'running',
        stage: 'generating',
        userMessages: [{ kind: 'revise', body: '把雨夜改成黄昏', round: 1 }]
      })
    )

    const initialIndex = textIndex(html, initialBubbleText)
    const labelIndex = textIndex(html, '第 1 轮修改要求 · 只读')
    const bodyIndex = textIndex(html, '把雨夜改成黄昏')
    const runStripIndex = textIndex(html, runStripText)

    expect(initialIndex).toBeLessThan(labelIndex)
    expect(labelIndex).toBeLessThan(bodyIndex)
    expect(bodyIndex).toBeLessThan(runStripIndex)
    // 运行中仍渲染进度卡，顺序调整没有把它隐藏掉。
    expect(html).toContain('查看运行详情')
  })

  it('首轮运行时，初始用户气泡仍排在进度卡之前', () => {
    const html = renderConversation(status({ state: 'running', stage: 'generating' }))

    const initialIndex = textIndex(html, initialBubbleText)
    const runStripIndex = textIndex(html, runStripText)

    expect(initialIndex).toBeLessThan(runStripIndex)
    expect(html).not.toContain('只读')
  })

  it('终态不再渲染进度卡，用户消息仍在结果气泡之前', () => {
    const html = renderConversation(
      status({
        state: 'succeeded',
        stage: 'completed',
        userMessages: [{ kind: 'revise', body: '把雨夜改成黄昏', round: 1 }],
        result: { commitId: 'commit-1' }
      })
    )

    expect(html).not.toContain(runStripText)
    expect(html).not.toContain('查看运行详情')

    const initialIndex = textIndex(html, initialBubbleText)
    const reviseIndex = textIndex(html, '把雨夜改成黄昏')
    const completedIndex = textIndex(html, '这一场已经写入作品，可以到作品历史查看。')

    expect(initialIndex).toBeLessThan(reviseIndex)
    expect(reviseIndex).toBeLessThan(completedIndex)
  })
})

describe('GenerationConversation pending start 视图', () => {
  const failedStatus = status({
    state: 'failed',
    stage: 'failed',
    stageMessage: '上一轮生成失败。',
    canPause: false,
    canResume: false,
    canCancel: false,
    failure: {
      code: 4101,
      message: '上一轮生成失败。',
      reason: 'modelFailure',
      failureClass: 'modelTransient',
      nextActions: ['retryOperation', 'viewCandidate'],
      reference: 'a1b2c3d4e5f6',
      unverified: false
    }
  })

  it('pending start 期间收起旧失败终态，只显示准备提示', () => {
    const html = renderConversation(failedStatus, {
      pending: true,
      pendingAction: 'start',
      startPhase: 'saving'
    })

    expect(html).toContain('正在准备生成…')
    expect(html).toContain(initialBubbleText)
    expect(html).not.toContain('上一轮生成失败。')
    expect(html).not.toContain('生成失败')
    expect(html).not.toContain('查看运行详情')
  })

  it('pending start 期间收起已提交终态与旧会话输入，避免旧内容回到新会话', () => {
    const html = renderConversation(
      status({
        state: 'succeeded',
        stage: 'completed',
        result: { commitId: 'commit-1' },
        answeredQuestions: [
          {
            questionId: 'q-old',
            prompt: '旧问题提示',
            optionId: 'o-old',
            label: '旧决定',
            description: '旧决定说明'
          }
        ],
        userMessages: [{ kind: 'revise', body: '旧修改要求', round: 1 }]
      }),
      { pending: true, pendingAction: 'start', startPhase: 'preparing' }
    )

    expect(html).toContain('正在准备生成…')
    expect(html).not.toContain('这一场已经写入作品，可以到作品历史查看。')
    expect(html).not.toContain('按画布重新生成')
    expect(html).not.toContain('旧问题提示')
    expect(html).not.toContain('旧决定说明')
    expect(html).not.toContain('旧修改要求')
  })

  it('start 失败后收起上一轮已提交结果与旧会话输入，只显示错误', () => {
    const html = renderConversation(
      status({
        state: 'succeeded',
        stage: 'completed',
        result: { commitId: 'commit-1' },
        answeredQuestions: [
          {
            questionId: 'q-old',
            prompt: '旧问题提示',
            optionId: 'o-old',
            label: '旧决定',
            description: '旧决定说明'
          }
        ],
        userMessages: [{ kind: 'revise', body: '旧修改要求', round: 1 }]
      }),
      {
        actionError: {
          kind: 'start',
          message: '画布保存失败，本次生成没有开始。',
          unverified: false
        }
      }
    )

    expect(html).toContain(initialBubbleText)
    expect(html).toContain('画布保存失败，本次生成没有开始。')
    expect(html).toContain('role="alert"')
    expect(html).not.toContain('这一场已经写入作品，可以到作品历史查看。')
    expect(html).not.toContain('按画布重新生成')
    expect(html).not.toContain('旧问题提示')
    expect(html).not.toContain('旧决定说明')
    expect(html).not.toContain('旧修改要求')
  })

  it('start 失败后收起上一轮失败终态，只保留新会话首条消息与错误', () => {
    const html = renderConversation(failedStatus, {
      actionError: {
        kind: 'start',
        message: '画布保存失败，本次生成没有开始。',
        unverified: false
      }
    })

    expect(html).toContain(initialBubbleText)
    expect(html).toContain('画布保存失败，本次生成没有开始。')
    expect(html).toContain('role="alert"')
    expect(html).not.toContain('上一轮生成失败。')
    expect(html).not.toContain('生成失败')
    expect(html).not.toContain('查看运行详情')
    expect(html).not.toContain('正在准备生成…')
  })

  it('新运行状态到达后恢复运行条，不再显示准备提示', () => {
    const html = renderConversation(status())

    expect(html).toContain(runStripText)
    expect(html).not.toContain('正在准备生成…')
  })

  it('新会话成功启动后只渲染新状态内容，不再出现旧会话内容', () => {
    const oldStatus = status({
      state: 'succeeded',
      stage: 'completed',
      result: { commitId: 'commit-1' },
      answeredQuestions: [
        {
          questionId: 'q-old',
          prompt: '旧问题提示',
          optionId: 'o-old',
          label: '旧决定',
          description: '旧决定说明'
        }
      ],
      userMessages: [{ kind: 'revise', body: '旧修改要求', round: 1 }]
    })
    const pendingHtml = renderConversation(oldStatus, {
      pending: true,
      pendingAction: 'start',
      startPhase: 'preparing'
    })

    const runningHtml = renderConversation(status({ operationId: 'operation-2' }))

    expect(pendingHtml).not.toContain('这一场已经写入作品，可以到作品历史查看。')
    expect(runningHtml).toContain(initialBubbleText)
    expect(runningHtml).toContain(runStripText)
    expect(runningHtml).not.toContain('正在准备生成…')
    expect(runningHtml).not.toContain('这一场已经写入作品，可以到作品历史查看。')
    expect(runningHtml).not.toContain('旧问题提示')
    expect(runningHtml).not.toContain('旧修改要求')
  })
})

describe('GenerationConversation pending resume 视图', () => {
  const pausedStatus = status({
    state: 'interrupted',
    stage: 'paused',
    stageMessage: '已暂停，可以继续。',
    checkpointId: 'checkpoint-1',
    canPause: false,
    canResume: true,
    canCancel: false,
    answeredQuestions: [
      {
        questionId: 'q-old',
        prompt: '旧问题提示',
        optionId: 'o-old',
        label: '旧决定',
        description: '旧决定说明'
      }
    ],
    userMessages: [{ kind: 'revise', body: '旧修改要求', round: 1 }]
  })

  it('pending resume 期间保留旧会话输入与暂停终态，不被新会话门控收起', () => {
    const html = renderConversation(pausedStatus, { pending: true, pendingAction: 'resume' })

    // resume 的 pendingAction 是 'resume'，pendingStart=false，新会话门控不生效：
    // 继续生成必须沿用旧会话的回答、修改要求和暂停终态。
    expect(html).not.toContain('正在准备生成…')

    const initialIndex = textIndex(html, initialBubbleText)
    const answerIndex = textIndex(html, '旧问题提示')
    const reviseIndex = textIndex(html, '旧修改要求')
    const pausedIndex = textIndex(html, '已暂停')

    expect(html).toContain('旧决定说明')
    expect(initialIndex).toBeLessThan(answerIndex)
    expect(answerIndex).toBeLessThan(pausedIndex)
    expect(reviseIndex).toBeLessThan(pausedIndex)
    expect(html).toContain('可以继续这次生成')
    expect(html).toContain('继续会沿用原任务、线程和检查点，不新建第二套记忆。')
    // 暂停气泡的「继续生成」按钮处于续跑请求中，显示进行中文案而非准备新会话。
    expect(html).toContain('正在继续…')
    expect(html).toContain('查看运行详情')
  })
})

const startFailure = {
  kind: 'start' as const,
  message: '画布保存失败，本次生成没有开始。',
  unverified: false
}

function renderRetry(overrides: Partial<Parameters<typeof GenerationStartRetry>[0]> = {}): string {
  return renderToStaticMarkup(
    createElement(GenerationStartRetry, {
      pending: false,
      startBlockedReason: null,
      workspaceNotReady: false,
      onStart: () => undefined,
      ...overrides
    })
  )
}

describe('GenerationConversation start 失败重试入口', () => {
  const completedStatus = status({
    state: 'succeeded',
    stage: 'completed',
    result: { commitId: 'commit-1' }
  })

  it('start 失败后旧终态入口收起，重试按钮渲染且点击调用 onStart', () => {
    const onStart = vi.fn()
    const html = renderConversation(completedStatus, {
      actionError: startFailure,
      onStart
    })

    expect(html).toContain(startFailure.message)
    expect(html).toContain('重试生成')
    expect(html).toContain('wb-gen-quiet')
    expect(html).toContain('type="button"')
    // 上一轮「按画布重新生成」仍随旧终态气泡收起，重试入口是唯一直接启动入口。
    expect(html).not.toContain('按画布重新生成')

    // 静态渲染不执行事件监听，直接调用无状态组件核对接线后再触发一次点击。
    const button = GenerationStartRetry({
      pending: false,
      startBlockedReason: null,
      workspaceNotReady: false,
      onStart
    })
    expect(button.props.onClick).toBe(onStart)
    button.props.onClick()
    expect(onStart).toHaveBeenCalledTimes(1)
  })

  it('pending、启动受阻或工作区未就绪时禁用重试按钮', () => {
    expect(renderRetry()).not.toContain('disabled=""')
    expect(renderRetry({ pending: true })).toContain('disabled=""')
    expect(renderRetry({ startBlockedReason: '当前场景已有进行中的生成' })).toContain('disabled=""')
    expect(renderRetry({ workspaceNotReady: true })).toContain('disabled=""')
  })

  it('startFailure 与实时运行态同时存在时不按新会话收起运行条和本轮输入', () => {
    const html = renderConversation(
      status({
        state: 'running',
        stage: 'generating',
        answeredQuestions: [
          {
            questionId: 'q-live',
            prompt: '本轮问题提示',
            optionId: 'o-live',
            label: '本轮决定',
            description: '本轮决定说明'
          }
        ],
        userMessages: [{ kind: 'revise', body: '本轮修改要求', round: 1 }]
      }),
      { actionError: startFailure }
    )

    expect(html).toContain(runStripText)
    expect(html).toContain('查看运行详情')
    expect(html).toContain('本轮问题提示')
    expect(html).toContain('本轮修改要求')
    expect(html).toContain(startFailure.message)
    expect(html).toContain('重试生成')
  })
})
