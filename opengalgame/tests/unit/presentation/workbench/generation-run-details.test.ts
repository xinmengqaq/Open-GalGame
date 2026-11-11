import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import type { SceneGenerationRenderStatusVO } from '@application/scene-generation/vo/SceneGenerationRenderVO'
import {
  GenerationRunDetailsPanel,
  GenerationRunStrip
} from '@presentation/pages/workbench/drawer/generation/GenerationRunDetails'
import { generationRunViewOf } from '@presentation/pages/workbench/drawer/generation/generationRunView'

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
    usage: {
      inputTokens: 1200,
      outputTokens: 3400,
      totalTokens: 4600,
      tokenLimit: 100000,
      modelCalls: 4,
      toolCalls: 7
    },
    previewAvailable: false,
    ...overrides
  }
}

function render(statusValue: SceneGenerationRenderStatusVO): string {
  const view = generationRunViewOf(statusValue)
  expect(view).not.toBeNull()
  return renderToStaticMarkup(createElement(GenerationRunDetailsPanel, { view: view! }))
}

function stageStates(html: string): readonly string[] {
  return [...html.matchAll(/class="wb-gen-details__stage" data-state="([^"]+)"/g)].map(
    (match) => match[1]
  )
}

describe('运行详情浮层内容', () => {
  it('固定显示六步阶段轨，运行中只给当前步活动节点', () => {
    const html = render(status())

    for (const label of ['准备', '读取输入', '生成候选', '校验 / 修正', '等待审阅', '提交']) {
      expect(html).toContain(label)
    }
    expect(stageStates(html)).toEqual(['done', 'done', 'active', 'pending', 'pending', 'pending'])
    expect(html).toContain('第 3 / 6 步')
  })

  it('阶段轨只按展示阶段定位，已完成显示六步完成', () => {
    const preparing = render(status({ state: 'pending', stage: 'readingInput' }))
    expect(stageStates(preparing)).toEqual(['done', 'active', 'pending', 'pending', 'pending', 'pending'])
    expect(preparing).toContain('第 2 / 6 步')
    expect(preparing).toContain('准备中')

    const completed = render(status({ state: 'succeeded', stage: 'completed' }))
    expect(stageStates(completed)).toEqual(['done', 'done', 'done', 'done', 'done', 'done'])
    expect(completed).toContain('六步完成')
  })

  it('暂停、失败和取消都不给活动节点，只显示终止说明', () => {
    for (const [statusValue, note] of [
      [status({ state: 'interrupted', stage: 'paused', canResume: true }), '已暂停'],
      [status({ state: 'failed', stage: 'failed' }), '本次运行已结束'],
      [status({ state: 'cancelled', stage: 'cancelled' }), '已取消']
    ] as const) {
      const html = render(statusValue)
      expect(stageStates(html).every((state) => state === 'idle')).toBe(true)
      expect(html).not.toContain('data-state="active"')
      expect(html).toContain(note)
      expect(html).toContain('阶段已停止')
    }
  })

  it('显示 Token 三数、模型/工具次数和最近活动，不显示耗时或秒数', () => {
    const html = render(
      status({
        activity: { kind: 'tool', lastActivityAt: '2026-11-04T12:00:07.000Z' }
      })
    )

    for (const text of ['1,200', '3,400', '4,600', '输入', '输出', '总计']) {
      expect(html).toContain(text)
    }
    expect(html).toContain('模型调用')
    expect(html).toContain('4 次')
    expect(html).toContain('工具调用')
    expect(html).toContain('7 次')
    expect(html).toContain('工具调用 ·')
    expect(html).toContain('11-04')
    expect(html).not.toContain('耗时')
    expect(html).not.toMatch(/\d+\s*秒/)
  })

  it('旧记录缺调用次数或活动时写没有记录，不补造数字', () => {
    const html = render(
      status({
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, tokenLimit: null }
      })
    )

    expect(html).toContain('没有记录')
    expect(html).not.toContain('0 次')
  })

  it('最近进度最多显示 6 条，旧的截断', () => {
    const recentProgress = Array.from({ length: 7 }, (_, index) => ({
      sequence: index + 1,
      createdAt: `2026-11-04T12:00:0${index}.000Z`,
      stage: 'generating' as const,
      message: `进度 ${index + 1}`
    }))
    const html = render(status({ recentProgress }))

    expect(html).toContain('最近 6 条')
    expect(html).not.toContain('进度 1')
    for (let index = 2; index <= 7; index += 1) {
      expect(html).toContain(`进度 ${index}`)
    }
    expect(html).toContain('07')
  })

  it('没有安全进度时不编造内容', () => {
    const html = render(status())
    expect(html).toContain('还没有可显示的进度说明')
  })
})

describe('运行详情紧凑行', () => {
  it('使用 Task / TaskTrigger 作为浮层入口，并保留工作台外观', () => {
    const view = generationRunViewOf(status())
    expect(view).not.toBeNull()
    const html = renderToStaticMarkup(createElement(GenerationRunStrip, { view: view! }))

    expect(html).toContain('data-slot="collapsible"')
    expect(html).toContain('wb-gen-run__row')
    expect(html).toContain('aria-haspopup="dialog"')
    expect(html).toContain('aria-label="查看运行详情：AI 正在生成候选脚本"')
    expect(html).toContain('查看运行详情')
    expect(html).toContain('AI 正在生成候选脚本')
    expect(html).toContain('第 3 / 6 步')
    expect((html.match(/<button/g) ?? []).length).toBe(1)
    expect(html).not.toContain('text-muted-foreground')
    expect(html).not.toContain('bg-secondary')
  })
})
