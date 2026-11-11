import { describe, expect, it } from 'vitest'

import type { ProjectInputSourceVO } from '@application/project-files/vo/ProjectInputSourceVO'
import type { SceneCanvasArrangementVO } from '@application/scene-canvas/vo/SceneCanvasArrangementVO'
import {
  arrangementDraftOf,
  draftArrangementOf,
  draftFingerprint,
  layoutAt,
  layoutForNaturalPreview,
  normalizeCardTitle,
  sourceCardKindOfSource,
  sourceDocumentFacts,
  sourceReadable
} from '@presentation/features/workbench-session/workbenchSessionMapper'
import { sourceFactsOf } from '@presentation/features/workbench-session/workbenchSessionSelectors'

const document: ProjectInputSourceVO = {
  sourceId: 'doc-1',
  version: 'v1',
  contentKind: 'text',
  textKind: 'document',
  title: '角色与场景',
  body: '# 正文',
  topics: ['角色', '地点'],
  importInfo: { format: 'markdown' }
}

const arrangement: SceneCanvasArrangementVO = {
  projectId: 'p-01',
  sceneId: 'scene-1',
  canvasId: 'canvas-1',
  viewport: { x: 12, y: 34, zoom: 0.9 },
  cards: [
    {
      kind: 'document',
      cardId: 'doc',
      sourceId: 'doc-1',
      title: '角色',
      summary: '简介',
      layout: { x: 1, y: 2, width: 300, height: 224 }
    },
    {
      kind: 'image',
      cardId: 'img',
      sourceId: 'img-1',
      role: 'background',
      title: '屋顶',
      summary: '屋顶夜景',
      layout: { x: 10, y: 20, width: 320, height: 208 }
    },
    {
      kind: 'prompt',
      cardId: 'prompt',
      body: '克制的对白',
      references: [],
      layout: { x: 30, y: 40, width: 320, height: 252 }
    },
    {
      kind: 'animation',
      cardId: 'anim',
      webgalPreset: { command: 'setAnimation', name: 'enter' },
      layout: { x: 50, y: 60, width: 296, height: 188 }
    }
  ],
  relations: [
    {
      relationId: 'rel-1',
      fromCardId: 'doc',
      toCardId: 'img',
      specificName: '同一场景',
      recordCardId: 'doc'
    }
  ]
}

describe('会话编排映射', () => {
  it('读取结果恢复视口并完整保留卡片与关联字段', () => {
    const draft = arrangementDraftOf(arrangement)
    expect(draft.viewport).toEqual({ x: 12, y: 34, zoom: 0.9 })
    expect(draft.cards.map((card) => [card.kind, card.cardId])).toEqual([
      ['document', 'doc'],
      ['image', 'img'],
      ['prompt', 'prompt'],
      ['animation', 'anim']
    ])
    expect(draft.relations[0]).toEqual({
      relationId: 'rel-1',
      fromCardId: 'doc',
      toCardId: 'img',
      specificName: '同一场景',
      recordCardId: 'doc'
    })
  })

  it('会话草稿可以原样构造成保存请求，不追加选中状态或版本', () => {
    const draft = arrangementDraftOf(arrangement)
    const sent = draftArrangementOf({
      projectId: 'p-01',
      sceneId: 'scene-1',
      canvasId: 'canvas-1',
      cards: draft.cards,
      relations: draft.relations,
      viewport: draft.viewport
    })
    expect(sent).toEqual(arrangement)
    expect(Object.keys(sent).sort()).toEqual([
      'canvasId',
      'cards',
      'projectId',
      'relations',
      'sceneId',
      'viewport'
    ])
  })

  it('指纹覆盖布局和视口，不把对象属性顺序当变化', () => {
    const base = draftFingerprint(arrangement.cards, arrangement.relations, arrangement.viewport)
    const moved = arrangement.cards.map((card) =>
      card.cardId === 'doc' ? { ...card, layout: { ...card.layout, x: 99 } } : card
    )
    expect(draftFingerprint(moved, arrangement.relations, arrangement.viewport)).not.toBe(base)
    const zoomed = draftFingerprint(arrangement.cards, arrangement.relations, {
      ...arrangement.viewport,
      zoom: 1.2
    })
    expect(zoomed).not.toBe(base)
    const image = arrangement.cards.find((card) => card.cardId === 'img')
    if (image?.kind !== 'image') throw new Error('fixture is not an image')
    const retitled = arrangement.cards.map((card) =>
      card.cardId === 'img' && card.kind === 'image' ? { ...card, summary: '另一用途' } : card
    )
    expect(draftFingerprint(retitled, arrangement.relations, arrangement.viewport)).not.toBe(base)
    expect(image.summary).toBe('屋顶夜景')
  })

  it('默认尺寸按卡片类别给出，预览尺寸按原始比例贴合', () => {
    expect(layoutAt('image', 10.4, 20.6)).toEqual({
      x: 10,
      y: 21,
      width: 320,
      height: 208
    })
    expect(layoutForNaturalPreview({ x: 10, y: 20, width: 320, height: 200 }, 1920, 1080)).toEqual({
      x: 10,
      y: 20,
      width: 320,
      height: 180
    })
    expect(normalizeCardTitle('  ')).toBeNull()
    expect(normalizeCardTitle('  标题  ')).toBe('标题')
  })

  it('文本来源建文档卡，不可读取来源不建卡', () => {
    expect(
      sourceCardKindOfSource(
        {
          sourceId: 'doc-1',
          name: '角色',
          readable: true,
          parentFolderId: null,
          contentKind: 'text',
          textKind: 'document'
        },
        undefined
      )
    ).toBe('document')
    expect(
      sourceCardKindOfSource(
        {
          sourceId: 'img-1',
          name: '屋顶',
          readable: false,
          parentFolderId: null,
          contentKind: 'image'
        },
        undefined
      )
    ).toBeNull()
    expect(sourceReadable(undefined, document)).toBe(true)
    expect(sourceReadable(undefined, undefined)).toBe(false)
  })

  it('文档正文和主题只从来源事实读取，不进入卡片', () => {
    const card = arrangement.cards[0]
    if (card?.kind !== 'document') throw new Error('fixture is not a document')
    const facts = sourceDocumentFacts(card, document)
    expect(facts.body).toBe('# 正文')
    expect(facts.topics).toEqual(['角色', '地点'])
    expect(facts.importFormat).toBe('markdown')
    expect(JSON.stringify(arrangement)).not.toContain('# 正文')
  })

  it('缺少摘要和详情时名称不是内部来源标识', () => {
    const missing = sourceFactsOf({ sources: [], sourceDetails: {} }, 'internal-source-id')
    expect(missing.disconnected).toBe(true)
    expect(missing.name).toBe('来源信息不可用')
    expect(missing.name).not.toContain('internal-source-id')
    expect(
      sourceFactsOf(
        {
          sources: [
            {
              sourceId: 'doc-1',
              name: '角色.md',
              readable: true,
              parentFolderId: null,
              contentKind: 'text',
              textKind: 'document'
            }
          ],
          sourceDetails: {}
        },
        'doc-1'
      ).name
    ).toBe('角色.md')
  })
})
