import { readFileSync } from 'node:fs'

import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import type { SceneGenerationRenderStatusVO } from '@application/scene-generation/vo/SceneGenerationRenderVO'
import type { SessionCard } from '@presentation/features/workbench-session/workbenchSession.types'
import {
  GenerationInputSummaryBar,
  GenerationInputSummaryPopover,
  GenerationInputSummaryView,
  type GenerationInputSummaryCount
} from '@presentation/pages/workbench/drawer/generation/GenerationInputSummary'

const LAYOUT = { x: 0, y: 0, width: 280, height: 200 }

function documentCard(cardId: string, title: string, summary: string): SessionCard {
  return { cardId, kind: 'document', layout: LAYOUT, sourceId: `source-${cardId}`, summary, title }
}

function imageCard(
  cardId: string,
  title: string,
  summary: string,
  role: 'background' | 'cg' | 'characterImage' | 'avatar'
): SessionCard {
  return {
    cardId,
    kind: 'image',
    layout: LAYOUT,
    role,
    sourceId: `source-${cardId}`,
    summary,
    title
  }
}

function audioCard(cardId: string, title: string, summary: string): SessionCard {
  return {
    cardId,
    kind: 'audio',
    layout: LAYOUT,
    role: 'music',
    sourceId: `source-${cardId}`,
    summary,
    title
  }
}

function videoCard(cardId: string, title: string, summary: string): SessionCard {
  return { cardId, kind: 'video', layout: LAYOUT, sourceId: `source-${cardId}`, summary, title }
}

function promptCard(cardId: string, body: string): SessionCard {
  return { body, cardId, kind: 'prompt', layout: LAYOUT, references: [] }
}

function animationCard(
  cardId: string,
  preset: { command: string; name: string } | null
): SessionCard {
  return { cardId, kind: 'animation', layout: LAYOUT, webgalPreset: preset }
}

function effectCard(cardId: string, preset: { command: string; name: string } | null): SessionCard {
  return { cardId, kind: 'effect', layout: LAYOUT, webgalPreset: preset }
}

function baseStatus(
  summary: Partial<SceneGenerationRenderStatusVO['inputSummary']> = {}
): SceneGenerationRenderStatusVO {
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
      documentCount: 0,
      assetCount: 0,
      promptCount: 0,
      fieldBindingCount: 0,
      relationCount: 0,
      confirmedControlCount: 0,
      ...summary
    },
    usage: { inputTokens: 0, outputTokens: 0, tokenLimit: null, totalTokens: 0 }
  }
}

function view(
  cards: readonly SessionCard[],
  status: SceneGenerationRenderStatusVO | null = null,
  extras: { loading?: boolean; loadError?: string | null } = {}
): string {
  return renderToStaticMarkup(
    createElement(GenerationInputSummaryView, { cards, status, ...extras })
  )
}

function bar(status: SceneGenerationRenderStatusVO | null, cards: readonly SessionCard[]): string {
  return renderToStaticMarkup(
    createElement(GenerationInputSummaryBar, {
      cards,
      onOpenChange: () => undefined,
      open: false,
      status
    })
  )
}

const mixedCards: readonly SessionCard[] = [
  documentCard('doc-1', '角色与场景', '角色、地点与人物关系'),
  imageCard('img-1', '工坊屋顶', '用作开场背景', 'background'),
  audioCard('audio-1', '夜色主题', '缓慢的夜间氛围'),
  videoCard('video-1', '开场影像', '开场镜头'),
  promptCard('prompt-1', '用克制的对白写出屋顶上的第一句。'),
  animationCard('anim-1', { command: 'setAnimation', name: '从左侧入场' }),
  effectCard('fx-1', null)
]

describe('GenerationInputSummaryView 启动前', () => {
  it('按类别分组显示真实卡片的标题、用途说明和字段命令', () => {
    const html = view(mixedCards)

    expect(html).toContain('角色与场景')
    expect(html).toContain('角色、地点与人物关系')
    expect(html).toContain('工坊屋顶')
    expect(html).toContain('用作开场背景')
    expect(html).toContain('夜色主题')
    expect(html).toContain('缓慢的夜间氛围')
    expect(html).toContain('开场影像')
    expect(html).toContain('用克制的对白写出屋顶上的第一句。')
    expect(html).toContain('从左侧入场')
    expect(html).toContain('setAnimation')
    expect(html).toContain('未选择预设')

    expect(html).toContain('字段绑定')
    expect(html).toContain('未用于本轮生成')
  })

  it('长提示词首行只作为标题出现一次，正文从首行之后接续', () => {
    const firstLine = '第一行提示词：让角色在雨里抬头看见伞。'
    const html = view([promptCard('prompt-long', `${firstLine}\n第二行继续写动作与对白。`)])

    expect(html).toContain(`>${firstLine}</span>`)
    expect(html).toContain('>正文</span>第二行继续写动作与对白。')
    expect(html).not.toContain(`>正文</span>${firstLine}`)
  })

  it('不显示 role 与用途说明的冲突提示', () => {
    const html = view(mixedCards)

    expect(html).not.toMatch(/>\s*(?:background|cg|characterImage|avatar)\s*</)
    expect(html).not.toMatch(/>\s*(?:music|soundEffect|voice)\s*</)
    expect(html).not.toContain('用途：背景')
    expect(html).not.toContain('角色不一致')
  })

  it('未消费的动画、特效不计入输入统计', () => {
    const html = view(mixedCards)

    /* 文档、图片、音频、视频、提示词共 5 项；动画和特效只作字段绑定。 */
    expect(html).toContain('画布输入共 5 项')
    expect(html).toContain('字段绑定')
    expect(html).toContain('2 项 · 未用于本轮生成')
  })

  it('无卡片时显示空态而不是伪造计数或分组', () => {
    const html = view([])

    expect(html).toContain('画布上还没有卡片')
    expect(html).toContain('画布输入共 0 项')
    expect(html).toContain('暂无输入')
  })

  it('只有字段卡片时说明没有可纳入的输入', () => {
    const html = view([animationCard('anim-only', null)])

    expect(html).toContain('画布上还没有可纳入生成的输入')
    expect(html).toContain('字段绑定')
    expect(html).toContain('1 项 · 未用于本轮生成')
  })
})

describe('GenerationInputSummaryView 启动后', () => {
  it('只显示本轮快照计数和“本轮输入已固定”，计数不再重复成统计带', () => {
    const html = view(
      mixedCards,
      baseStatus({
        documentCount: 1,
        assetCount: 2,
        promptCount: 1,
        fieldBindingCount: 2,
        relationCount: 1,
        confirmedControlCount: 0
      })
    )

    expect(html).toContain('本轮输入已固定')
    expect(html).toContain('本轮输入共 5 项')
    expect(html).toContain('文档')
    expect(html).toContain('素材')
    expect(html).toContain('提示词')
    expect(html).toContain('关联')
    expect(html).toContain('已确认控制')
    /* 甜甜圈图例已经是唯一计数来源，不再渲染第二组快照计数块。 */
    expect(html).not.toContain('wb-gen-summary__snapshot-grid')
  })

  it('不补造快照没有的卡片正文', () => {
    const html = view(mixedCards, baseStatus({ documentCount: 1, assetCount: 1 }))

    expect(html).not.toContain('角色与场景')
    expect(html).not.toContain('角色、地点与人物关系')
    expect(html).not.toContain('setAnimation')
    expect(html).not.toContain('从左侧入场')
    /* 快照没有明细时也不占位渲染明细块。 */
    expect(html).not.toContain('wb-gen-summary__details')
  })

  it('显示快照附带的安全明细，按类别分组', () => {
    const html = view(
      mixedCards,
      baseStatus({
        documentCount: 1,
        promptCount: 1,
        relationCount: 1,
        details: {
          documents: ['角色与场景'],
          prompts: ['基础生成 · 场景'],
          relations: ['林晚与场景（记录：文档）']
        }
      })
    )

    expect(html).toContain('wb-gen-summary__details')
    expect(html).toContain('角色与场景')
    expect(html).toContain('基础生成 · 场景')
    expect(html).toContain('林晚与场景（记录：文档）')
    const detailsHtml = html.slice(html.indexOf('wb-gen-summary__details"'))
    expect((detailsHtml.match(/<li/g) ?? []).length).toBe(3)
  })

  it('明细最多 12 条，溢出以等 N 项收尾', () => {
    const documents = [
      ...Array.from({ length: 11 }, (_, index) => `文档 ${index + 1}`),
      '等 5 项'
    ]
    const html = view([], baseStatus({ documentCount: 16, details: { documents } }))

    const detailsHtml = html.slice(html.indexOf('wb-gen-summary__details"'))
    expect((detailsHtml.match(/<li/g) ?? []).length).toBe(12)
    expect(detailsHtml).toContain('等 5 项')
    expect(detailsHtml).toContain('文档 11')
  })

  it('字段绑定只作快照计数并标注未用于本轮生成', () => {
    const html = view([], baseStatus({ documentCount: 1, fieldBindingCount: 2 }))

    expect(html).toContain('动画 / 特效')
    expect(html).toContain('2 项')
    expect(html).toContain('字段绑定，未用于本轮生成')
    expect(html).not.toContain('已纳入')
  })

  it('是只读视图，不提供编辑或虚假动作', () => {
    const html = view(mixedCards, baseStatus({ documentCount: 1 }))

    expect(html).toContain('只读 · 不再重新读取')
    expect(html).toContain('本轮输入已固定')
    expect(html).not.toContain('<button')
    expect(html).not.toContain('<input')
  })
})

describe('GenerationInputSummaryView 加载、错误与只读', () => {
  it('加载中显示明确状态，不先放一个 0 计数', () => {
    const html = view([], null, { loading: true })

    expect(html).toContain('正在读取画布上的输入')
    expect(html).toContain('role="status"')
    expect(html).not.toContain('wb-gen-chart__ring')
  })

  it('读取失败显示安全文案和错误状态', () => {
    const html = view([], null, { loadError: '画布输入暂时没有读到，请重新打开抽屉。' })

    expect(html).toContain('画布输入没有读取到')
    expect(html).toContain('画布输入暂时没有读到')
    expect(html).toContain('role="alert"')
    expect(html).not.toContain('wb-gen-chart__ring')
  })

  it('有快照时优先显示快照，不因卡片加载状态退回空态', () => {
    const html = view([], baseStatus({ documentCount: 1 }), {
      loading: true,
      loadError: '画布输入暂时没有读到'
    })

    expect(html).toContain('本轮输入已固定')
    expect(html).not.toContain('正在读取画布上的输入')
    expect(html).not.toContain('画布输入没有读取到')
  })
})

describe('GenerationInputSummaryBar', () => {
  it('单行显示分类计数，不重复渲染分组列表', () => {
    const html = bar(null, mixedCards)

    expect(html).toContain('输入摘要')
    expect(html).toContain('当前画布 · 文档 1 · 图片 1 · 音频 1 · 视频 1 · 提示词 1')
    expect(html).not.toContain('角色与场景')
    expect(html).not.toContain('setAnimation')
    expect(html).not.toContain('wb-gen-summary-bar__panel')
    expect(html).not.toContain('查看完整摘要')
  })

  it('使用 Popover 触发按钮，关闭状态不渲染浮层内容', () => {
    const html = bar(null, mixedCards)

    expect(html).toContain('aria-haspopup="dialog"')
    expect(html).toContain('aria-expanded="false"')
    expect(html).toContain('data-state="closed"')
    expect(html).not.toContain('role="dialog"')
    expect(html).not.toContain('输入分类计数')
  })

  it('启动后只显示快照分类计数，不把字段绑定算作已纳入输入', () => {
    const html = bar(
      baseStatus({ documentCount: 1, assetCount: 2, fieldBindingCount: 3, relationCount: 1 }),
      mixedCards
    )

    expect(html).toContain('本轮快照 · 文档 1 · 素材 2 · 关联 1')
    expect(html).not.toContain('动画 / 特效')
  })
})

describe('GenerationInputSummaryPopover', () => {
  const entries: readonly GenerationInputSummaryCount[] = [
    { count: 1, key: 'document', label: '文档', unconsumed: false },
    { count: 2, key: 'animation', label: '动画', unconsumed: true },
    { count: 0, key: 'effect', label: '特效', unconsumed: true }
  ]

  it('只显示分类计数和“查看完整摘要”，不渲染分组列表', () => {
    const html = renderToStaticMarkup(
      createElement(GenerationInputSummaryPopover, {
        entries,
        onViewFullSummary: () => undefined
      })
    )

    expect(html).toContain('文档')
    expect(html).toContain('动画')
    expect(html).toContain('特效')
    expect(html).toContain('未用于本轮生成')
    expect(html).toContain('查看完整摘要')
    expect(html).not.toContain('角色与场景')
    expect(html).not.toContain('本轮输入已固定')
    expect(html).not.toContain('启动生成会先保存画布')
  })

  it('旧调用没有完整摘要入口时只保留计数，不显示假动作', () => {
    const html = renderToStaticMarkup(createElement(GenerationInputSummaryPopover, { entries }))

    expect(html).toContain('文档')
    expect(html).not.toContain('查看完整摘要')
  })
})

describe('输入摘要样式边界', () => {
  const source = readFileSync(
    new URL(
      '../../../../src/presentation/pages/workbench/drawer/generation/GenerationInputSummary.tsx',
      import.meta.url
    ),
    'utf8'
  )
  const css = readFileSync(
    new URL(
      '../../../../src/presentation/pages/workbench/drawer/generation/generation.summary.css',
      import.meta.url
    ),
    'utf8'
  )
  const themeCss = readFileSync(
    new URL(
      '../../../../src/presentation/pages/workbench/workbenchTheme.module.css',
      import.meta.url
    ),
    'utf8'
  )
  const tokensCss = readFileSync(
    new URL('../../../../src/presentation/effects/tokens.css', import.meta.url),
    'utf8'
  )
  const summaryCss = css.split('/* ---------- 确认框 ---------- */')[0] ?? ''

  function declaredProperties(text: string): Set<string> {
    return new Set(
      [...text.matchAll(/(--[a-z0-9-]+)\s*:/gi)].map((match) => match[1].toLowerCase())
    )
  }

  function referencedProperties(text: string): string[] {
    return [...text.matchAll(/var\(\s*(--[a-z0-9-]+)/gi)].map((match) => match[1].toLowerCase())
  }

  it('不再使用 Collapsible 原位展开或折叠面板样式', () => {
    expect(source).not.toContain('Collapsible')
    expect(css).not.toContain('wb-gen-summary-bar__panel')
    expect(css).not.toContain('wb-gen-summary__empty')
  })

  it('颜色只来自 --wb-* 与 tokens.css，摘要样式不写裸色值', () => {
    expect(summaryCss).not.toMatch(/#[0-9a-fA-F]{3,8}\b/)
    expect(summaryCss).not.toMatch(/\b(?:rgba?|hsla?)\s*\(/)

    const allowed = new Set([...declaredProperties(themeCss), ...declaredProperties(tokensCss)])
    const used = referencedProperties(summaryCss)
    expect(used.length).toBeGreaterThan(0)
    for (const name of used) {
      expect(allowed.has(name), `${name} 不在 --wb-* 或 tokens.css 中`).toBe(true)
    }
  })

  it('轻量浮层只包含计数与入口，不再包含折叠条说明文字', () => {
    const popoverCss = summaryCss.slice(summaryCss.indexOf('.wb-gen-summary__popover'))
    expect(popoverCss).toContain('.wb-gen-summary__counts')
    expect(popoverCss).toContain('.wb-gen-summary__popover-action')
    expect(summaryCss).not.toContain('wb-gen-summary-bar__panel p')
  })
})
