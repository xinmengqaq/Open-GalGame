import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import type {
  SceneGenerationRenderStatusVO,
  SceneGenerationUsageVO
} from '@application/scene-generation/vo/SceneGenerationRenderVO'
import { ErrorCodes } from '@common/errors/ErrorCodes'
import type { SceneGenerationClient } from '@interfaces/scene-generation/client/SceneGenerationClient'
import { GenerationHistory } from '@presentation/pages/workbench/drawer/generation/GenerationHistory'
import { GenerationHeader } from '@presentation/pages/workbench/drawer/generation/GenerationPanel'
import type { GenerationActionFailure } from '@presentation/pages/workbench/drawer/generation/generationPresentation'

function usageOf(
  inputTokens: number,
  outputTokens: number,
  totalTokens: number,
  tokenLimit: number | null
): SceneGenerationUsageVO {
  return { inputTokens, outputTokens, totalTokens, tokenLimit }
}

function status(tokenLimit: number | null): SceneGenerationRenderStatusVO {
  return {
    ...baseStatus(),
    usage: usageOf(1200, 3400, 4600, tokenLimit)
  }
}

function statusWithUsage(usage: SceneGenerationUsageVO): SceneGenerationRenderStatusVO {
  return { ...baseStatus(), usage }
}

function baseStatus(): SceneGenerationRenderStatusVO {
  return {
    projectId: 'project-1',
    sceneId: 'scene-1',
    operationId: 'operation-1',
    threadId: 'thread-1',
    branchId: 'branch-1',
    checkpointId: 'checkpoint-1',
    state: 'running',
    stage: 'writing',
    stageMessage: '正在生成',
    attempt: 1,
    sequence: 12,
    canPause: true,
    canResume: false,
    canCancel: true,
    inputSummary: {
      canvasId: 'canvas-1',
      arrangementVersion: 'version-1',
      documentCount: 1,
      assetCount: 0,
      promptCount: 0,
      fieldBindingCount: 0,
      relationCount: 0,
      confirmedControlCount: 0
    },
    usage: usageOf(0, 0, 0, null)
  }
}

describe('GenerationHeader Token 统计', () => {
  function header(usage: SceneGenerationUsageVO): string {
    return renderToStaticMarkup(
      createElement(GenerationHeader, {
        projectName: '测试工程',
        sceneLabel: '第一场',
        status: statusWithUsage(usage)
      })
    )
  }

  /** 按单元格标签取可见文本，避免只看 data-value 而漏掉输入/输出互换。 */
  function visibleToken(html: string, label: '输入' | '输出' | '总计'): string {
    const match = html.match(new RegExp(`<span>${label}</span><strong>(.*?)</strong>`, 's'))
    expect(match, `${label} 单元格`).not.toBeNull()
    return match![1].replace(/<[^>]*>/g, '')
  }

  it('输入、输出、总计的可见文本分别来自状态 VO 的 usage', () => {
    const html = header(usageOf(912, 734, 1646, null))

    expect(visibleToken(html, '输入')).toBe('912')
    expect(visibleToken(html, '输出')).toBe('734')
    expect(visibleToken(html, '总计')).toBe('1,646')
  })

  it('两次静态渲染显示各自的 usage，不复用上一组文本', () => {
    const first = header(usageOf(912, 734, 1646, null))
    const second = header(usageOf(12345, 6789, 19134, null))

    expect(visibleToken(first, '输入')).toBe('912')
    expect(visibleToken(first, '输出')).toBe('734')
    expect(visibleToken(first, '总计')).toBe('1,646')
    expect(visibleToken(second, '输入')).toBe('12,345')
    expect(visibleToken(second, '输出')).toBe('6,789')
    expect(visibleToken(second, '总计')).toBe('19,134')
  })
})

describe('GenerationHeader 只保留 Token 三数', () => {
  function header(statusValue: SceneGenerationRenderStatusVO | null): string {
    return renderToStaticMarkup(
      createElement(GenerationHeader, {
        projectName: '测试工程',
        sceneLabel: '第一场',
        status: statusValue
      })
    )
  }

  it('运行中的模型次数、工具次数和最近活动不进入头部', () => {
    const html = header({
      ...statusWithUsage({
        ...usageOf(12, 3, 15, null),
        modelCalls: 4,
        toolCalls: 7
      }),
      activity: { kind: 'model', lastActivityAt: '2026-10-29T00:00:00.000Z' }
    })

    expect(html).not.toContain('模型 4 次')
    expect(html).not.toContain('工具 7 次')
    expect(html).not.toContain('最近活动')
    expect(html).not.toContain('等待模型')
    expect(html).not.toMatch(/\d+ 秒/)
    expect(html).toContain('>输入<')
    expect(html).toContain('>输出<')
    expect(html).toContain('>总计<')
  })

  it('旧记录没有活动或计数时头部也不出现新增指标', () => {
    const html = header(status(null))

    expect(html).not.toContain('模型 ')
    expect(html).not.toContain('工具 ')
    expect(html).not.toContain('最近活动')
  })

  it('没有当前操作时只显示未开始，不显示 Token 或实时指标', () => {
    const html = header(null)

    expect(html).toContain('尚未开始生成')
    expect(html).not.toContain('输入')
    expect(html).not.toContain('最近活动')
  })

  it('等待模型和终态都不在头部显示等待或秒数', () => {
    for (const statusValue of [
      {
        ...statusWithUsage({ ...usageOf(1, 1, 2, null), modelCalls: 2, toolCalls: 3 }),
        activity: {
          kind: 'waitingModel' as const,
          lastActivityAt: new Date(Date.now() - 4000).toISOString()
        }
      },
      {
        ...statusWithUsage({ ...usageOf(1, 1, 2, null), modelCalls: 2, toolCalls: 3 }),
        state: 'failed' as const,
        stage: 'failed' as const,
        stageMessage: '等待模型响应（连接较慢时可继续等待或取消）',
        activity: {
          kind: 'waitingModel' as const,
          lastActivityAt: new Date(Date.now() - 4000).toISOString()
        }
      }
    ]) {
      const html = header(statusValue)
      expect(html).not.toContain('等待模型')
      expect(html).not.toMatch(/\d+ 秒/)
    }
  })
})

describe('GenerationHeader 重新生成与 start 失败', () => {
  const failedStatus: SceneGenerationRenderStatusVO = {
    ...baseStatus(),
    state: 'failed',
    stage: 'failed',
    stageMessage: '生成已停止'
  }
  const completedStatus: SceneGenerationRenderStatusVO = {
    ...baseStatus(),
    state: 'succeeded',
    stage: 'completed',
    stageMessage: '作品已提交'
  }
  const startFailure: GenerationActionFailure = {
    kind: 'start',
    message: '画布没有保存成功，暂时不能开始生成。',
    unverified: false
  }
  const previousUsage = usageOf(69187, 3838, 73025, null)
  const completedWithUsage: SceneGenerationRenderStatusVO = {
    ...completedStatus,
    usage: previousUsage
  }
  const failedWithUsage: SceneGenerationRenderStatusVO = { ...failedStatus, usage: previousUsage }

  function renderHeader(
    statusValue: SceneGenerationRenderStatusVO | null,
    options: { pendingStart?: boolean; startFailure?: GenerationActionFailure | null } = {}
  ): string {
    return renderToStaticMarkup(
      createElement(GenerationHeader, {
        pendingStart: options.pendingStart,
        projectName: '测试工程',
        sceneLabel: '第一场',
        startFailure: options.startFailure,
        status: statusValue
      })
    )
  }

  function expectPill(
    html: string,
    label: string,
    tone: 'ready' | 'live' | 'wait' | 'done' | 'danger' | 'muted'
  ): void {
    expect(html).toContain(
      `<span class="wb-gen-pill" data-tone="${tone}"><i aria-hidden="true"></i>${label}</span>`
    )
  }

  it('重新生成等待期不显示上一轮终态，改为准备中', () => {
    for (const oldStatus of [failedStatus, completedStatus, null]) {
      const html = renderHeader(oldStatus, { pendingStart: true })

      expectPill(html, '准备中', 'live')
      expect(html).not.toContain('生成失败')
      expect(html).not.toContain('已提交')
    }
  })

  it('start 失败时头部显示启动失败，不叠旧终态', () => {
    for (const oldStatus of [failedStatus, completedStatus, null]) {
      const html = renderHeader(oldStatus, { startFailure })

      expectPill(html, '启动失败', 'danger')
      expect(html).not.toContain('生成失败')
      expect(html).not.toContain('已提交')
    }
  })

  it('不在等待或失败窗口时仍按 status 显示，查看旧 operation 不受影响', () => {
    expectPill(renderHeader(failedStatus), '生成失败', 'danger')
    expectPill(renderHeader(completedStatus), '已提交', 'done')
  })

  it('实时状态优先于 start 失败，通信恢复后不继续停在启动失败', () => {
    const html = renderHeader(baseStatus(), { startFailure })

    expectPill(html, '生成中', 'live')
    expect(html).not.toContain('启动失败')
  })

  it('重新生成等待期头部不显示上一轮 usage，回落到未开始占位', () => {
    for (const oldStatus of [completedWithUsage, failedWithUsage]) {
      const html = renderHeader(oldStatus, { pendingStart: true })

      expect(html).toContain('尚未开始生成')
      expect(html).toContain('开始后会显示本次操作的累计 Token')
      expect(html).not.toContain('>输入<')
      expect(html).not.toContain('>总计<')
      expect(html).not.toContain('69,187')
      expect(html).not.toContain('73,025')
    }
  })

  it('start 失败的新会话视图不显示上一轮 usage，回落到未开始占位', () => {
    for (const oldStatus of [completedWithUsage, failedWithUsage]) {
      const html = renderHeader(oldStatus, { startFailure })

      expect(html).toContain('尚未开始生成')
      expect(html).toContain('开始后会显示本次操作的累计 Token')
      expect(html).not.toContain('>输入<')
      expect(html).not.toContain('>总计<')
      expect(html).not.toContain('69,187')
      expect(html).not.toContain('73,025')
    }
  })

  it('实时 running 状态与 start 失败同存时仍按本轮状态显示 usage', () => {
    const html = renderHeader(
      { ...baseStatus(), usage: usageOf(3200, 640, 3840, null) },
      { startFailure }
    )

    expectPill(html, '生成中', 'live')
    expect(html).not.toContain('尚未开始生成')
    expect(html).toContain('>输入<')
    expect(html).toContain('>输出<')
    expect(html).toContain('>总计<')
    expect(html).toContain('3,200')
    expect(html).toContain('3,840')
  })

  it('不在新会话尝试期时仍显示旧终态 usage，历史查看不受影响', () => {
    const html = renderHeader(completedWithUsage)

    expectPill(html, '已提交', 'done')
    expect(html).not.toContain('尚未开始生成')
    expect(html).toContain('>输入<')
    expect(html).toContain('69,187')
    expect(html).toContain('73,025')
  })

  it('resume 不进入新会话门控：暂停可续跑时头部仍显示本轮旧 usage', () => {
    const pausedWithUsage: SceneGenerationRenderStatusVO = {
      ...baseStatus(),
      state: 'interrupted',
      stage: 'paused',
      stageMessage: '已暂停，可以继续。',
      checkpointId: 'checkpoint-1',
      canPause: false,
      canResume: true,
      canCancel: false,
      usage: previousUsage
    }

    // resume 期间 pending === 'resume'，GenerationPanel 传入 pendingStart=false；
    // 头部门控只认 start pending / start 失败，续跑暂停态不属于新会话。
    const html = renderHeader(pausedWithUsage, { pendingStart: false })

    expectPill(html, '已暂停', 'muted')
    expect(html).not.toContain('尚未开始生成')
    expect(html).toContain('>输入<')
    expect(html).toContain('>输出<')
    expect(html).toContain('>总计<')
    expect(html).toContain('69,187')
    expect(html).toContain('73,025')
  })
})

describe('AI 历史进行中行', () => {
  const client = {
    listHistory: async () => ({ code: ErrorCodes.success, msg: '成功', data: [] })
  } as unknown as SceneGenerationClient

  function historyHtml(
    activeStatus: SceneGenerationRenderStatusVO | null,
    canCancel = true
  ): string {
    return renderToStaticMarkup(
      createElement(GenerationHistory, {
        activeStatus,
        canCancel,
        client,
        onCancel: () => undefined,
        onOpenRun: () => undefined,
        projectId: 'project-1',
        sceneId: 'scene-1'
      })
    )
  }

  it('运行中在 AI 历史顶部显示进行中行和等待模型文案，并提供查看详情与取消', () => {
    const html = historyHtml({
      ...baseStatus(),
      stage: 'generating',
      stageMessage: '等待模型响应（连接较慢时可继续等待或取消）',
      activity: { kind: 'waitingModel', lastActivityAt: '2026-10-29T00:00:00.000Z' }
    })

    expect(html).toContain('进行中')
    expect(html).toContain('等待模型响应')
    expect(html).toContain('查看运行详情')
    expect(html).toContain('>取消<')
  })

  it('不可取消时只保留查看详情，终态不在历史顶部显示进行中行', () => {
    const notCancellable = historyHtml(baseStatus(), false)
    expect(notCancellable).toContain('查看运行详情')
    expect(notCancellable).not.toContain('>取消<')

    const failed = historyHtml({
      ...baseStatus(),
      state: 'failed',
      stage: 'failed',
      stageMessage: '生成已停止'
    })
    expect(failed).not.toContain('进行中')
    expect(failed).not.toContain('查看运行详情')
  })
})
