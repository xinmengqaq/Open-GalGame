import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  assertCanvasMigrationManifest,
  CANVAS_MIGRATION_TOOL_VERSION,
  createCanvasMigrationManifest
} from '@infrastructure/scene-canvas/migration/canvasArrangementBackupManifest'
import { planCanvasArrangementMigration } from '@infrastructure/scene-canvas/migration/canvasArrangementMigrationPlan'

const require = createRequire(import.meta.url)
const r27 = require('../../../scripts/legacy-data-migration/manifest.cjs') as {
  assertManifest(value: unknown): unknown
}

const IDENTITY = { projectId: 'project-1', sceneId: 'scene-1', canvasId: 'canvas-1' }
const SOURCE_DIGEST = 'a'.repeat(64)

type LegacyCanvasDocumentFixture = {
  formatVersion: number
  projectId: string
  sceneId: string
  canvasId: string
  viewport: { x: number; y: number; zoom: number }
  cards: Record<string, unknown>[]
  relations: { [key: string]: unknown; toCardId: string }[]
}

function layout(x = 0): { x: number; y: number; width: number; height: number } {
  return { x, y: 0, width: 100, height: 80 }
}

function v3Document(): LegacyCanvasDocumentFixture {
  return {
    formatVersion: 3,
    ...IDENTITY,
    viewport: { x: 1, y: 2, zoom: 1.5 },
    cards: [
      {
        kind: 'document',
        cardId: 'doc',
        sourceId: 'source-doc',
        title: '设定',
        summary: '设定摘要',
        usage: { characterId: 'char-1', targetIds: ['img'] },
        layout: layout()
      },
      {
        kind: 'image',
        cardId: 'img',
        sourceId: 'source-img',
        role: 'background',
        title: '背景',
        usage: { targetIds: [] },
        layout: layout(20)
      },
      {
        kind: 'prompt',
        cardId: 'prompt',
        title: '提示词',
        summary: '提示词摘要',
        body: '提示词正文',
        usage: { locationId: 'room-1', targetIds: ['img'] },
        layout: layout(40)
      }
    ],
    relations: [
      {
        relationId: 'rel',
        fromCardId: 'prompt',
        toCardId: 'img',
        defaultRelation: 'actsOn',
        specificName: '引用',
        recordCardId: null
      }
    ]
  }
}

function v4Document(): LegacyCanvasDocumentFixture {
  return {
    formatVersion: 4,
    ...IDENTITY,
    viewport: { x: 0, y: 0, zoom: 1 },
    cards: [
      {
        kind: 'document',
        cardId: 'doc',
        sourceId: 'source-doc',
        title: '设定',
        summary: '设定摘要',
        layout: layout()
      },
      {
        kind: 'image',
        cardId: 'img',
        sourceId: 'source-img',
        role: 'background',
        title: '背景',
        layout: layout(20)
      },
      {
        kind: 'prompt',
        cardId: 'prompt',
        body: '提示词正文',
        layout: layout(40)
      },
      {
        kind: 'animation',
        cardId: 'anim',
        webgalPreset: { command: 'setAnimation', name: 'shake' },
        layout: layout(60)
      }
    ],
    relations: [
      {
        relationId: 'rel',
        fromCardId: 'prompt',
        toCardId: 'doc',
        specificName: '引用',
        recordCardId: 'doc'
      }
    ]
  }
}

describe('画布旧格式迁移规划（纯函数）', () => {
  it('v3 逐项保留真实字段，缺省简介与引用分别记为默认值和归一化', () => {
    const plan = planCanvasArrangementMigration(v3Document(), IDENTITY, SOURCE_DIGEST)
    expect(plan.ok).toBe(true)
    if (!plan.ok) throw new Error('合法旧 v3 必须可迁移')
    expect(plan.sourceVersion).toBe(3)
    expect(plan.targetVersion).toBe(5)
    expect(plan.document.formatVersion).toBe(5)
    expect(plan.unsupported).toEqual([])

    expect(plan.preserved).toEqual(
      expect.arrayContaining([
        'projectId',
        'viewport',
        'cards[doc].title',
        'cards[doc].summary',
        'cards[doc].usage',
        'cards[prompt].title',
        'cards[prompt].summary',
        'cards[img].title',
        'relations[rel].defaultRelation'
      ])
    )
    expect(plan.preserved).not.toContain('cards[img].summary')
    expect(plan.defaulted).toEqual([
      { object: 'card', objectId: 'img', field: 'summary', source: 'v3-schema-default' }
    ])
    expect(plan.normalized).toEqual([
      {
        object: 'card',
        objectId: 'prompt',
        field: 'references',
        reason: 'v3-absent-references'
      }
    ])

    const image = plan.document.cards.find((card) => card.cardId === 'img')
    expect(image).toMatchObject({ summary: '', usage: { targetIds: [] } })
    const prompt = plan.document.cards.find((card) => card.cardId === 'prompt')
    expect(prompt).toMatchObject({
      title: '提示词',
      summary: '提示词摘要',
      body: '提示词正文',
      references: [],
      usage: { locationId: 'room-1', targetIds: ['img'] }
    })
    expect(plan.document.relations[0]).toMatchObject({
      defaultRelation: 'actsOn',
      specificName: '引用',
      recordCardId: null
    })
  })

  it('v4 未保存字段逐项标注来源，真实字段与预设原样保留', () => {
    const plan = planCanvasArrangementMigration(v4Document(), IDENTITY, SOURCE_DIGEST)
    expect(plan.ok).toBe(true)
    if (!plan.ok) throw new Error('合法旧 v4 必须可迁移')
    expect(plan.sourceVersion).toBe(4)
    expect(plan.preserved).toEqual(
      expect.arrayContaining([
        'cards[doc].summary',
        'cards[img].title',
        'cards[prompt].body',
        'cards[anim].webgalPreset',
        'relations[rel].recordCardId'
      ])
    )
    expect(plan.preserved).not.toContain('cards[img].summary')
    expect(plan.preserved).not.toContain('cards[prompt].title')
    expect(plan.defaulted).toEqual([
      { object: 'card', objectId: 'doc', field: 'usage', source: 'v4-not-saved' },
      { object: 'card', objectId: 'img', field: 'summary', source: 'v4-schema-default' },
      { object: 'card', objectId: 'img', field: 'usage', source: 'v4-not-saved' },
      { object: 'card', objectId: 'prompt', field: 'title', source: 'v4-not-saved' },
      { object: 'card', objectId: 'prompt', field: 'summary', source: 'v4-not-saved' },
      { object: 'card', objectId: 'prompt', field: 'usage', source: 'v4-not-saved' },
      { object: 'card', objectId: 'anim', field: 'title', source: 'v4-not-saved' },
      { object: 'card', objectId: 'anim', field: 'summary', source: 'v4-not-saved' },
      { object: 'card', objectId: 'anim', field: 'usage', source: 'v4-not-saved' },
      { object: 'relation', objectId: 'rel', field: 'defaultRelation', source: 'v4-not-saved' }
    ])
    expect(plan.normalized).toEqual([
      {
        object: 'card',
        objectId: 'prompt',
        field: 'references',
        reason: 'v4-absent-references'
      }
    ])
    expect(plan.document.cards.find((card) => card.cardId === 'prompt')).toMatchObject({
      title: 'prompt',
      summary: '',
      references: [],
      usage: { targetIds: [] }
    })
    expect(plan.document.cards.find((card) => card.cardId === 'anim')).toMatchObject({
      title: 'anim',
      webgalPreset: { command: 'setAnimation', name: 'shake' }
    })
    expect(plan.document.relations[0]).toMatchObject({ defaultRelation: 'associated' })
  })

  it('当前 v5、未知版本、损坏内容与身份不符都不产生迁移文档', () => {
    expect(
      planCanvasArrangementMigration({ ...v3Document(), formatVersion: 5 }, IDENTITY, SOURCE_DIGEST)
    ).toEqual({ ok: false, reason: 'current', sourceVersion: 5 })
    expect(
      planCanvasArrangementMigration({ ...v3Document(), formatVersion: 8 }, IDENTITY, SOURCE_DIGEST)
    ).toEqual({ ok: false, reason: 'unsupported', sourceVersion: 8 })
    expect(planCanvasArrangementMigration('not-a-document', IDENTITY, SOURCE_DIGEST)).toEqual({
      ok: false,
      reason: 'damaged',
      sourceVersion: null
    })
    expect(
      planCanvasArrangementMigration(
        {
          ...v4Document(),
          cards: [
            {
              kind: 'prompt',
              cardId: 'prompt',
              body: '正文',
              usage: { targetIds: [] },
              layout: layout()
            }
          ]
        },
        IDENTITY,
        SOURCE_DIGEST
      )
    ).toEqual({ ok: false, reason: 'damaged', sourceVersion: 4 })
    expect(
      planCanvasArrangementMigration(
        v3Document(),
        { ...IDENTITY, canvasId: 'other' },
        SOURCE_DIGEST
      )
    ).toEqual({ ok: false, reason: 'identity', sourceVersion: 3 })
    const invalid = v3Document()
    invalid.relations[0]!.toCardId = 'missing-card'
    expect(planCanvasArrangementMigration(invalid, IDENTITY, SOURCE_DIGEST)).toEqual({
      ok: false,
      reason: 'damaged',
      sourceVersion: 3
    })
  })

  it('旧 v4/v3 领域非法与非法引用逐项由迁移规划判损坏，不产生迁移文档', () => {
    type PlainDocument = Record<string, unknown>
    const cardsOf = (document: PlainDocument): PlainDocument[] => {
      const cards = document.cards
      if (!Array.isArray(cards)) throw new Error('测试画布缺少卡片')
      return cards as PlainDocument[]
    }
    const cardOfKind = (document: PlainDocument, kind: string): PlainDocument => {
      const card = cardsOf(document).find((item) => item.kind === kind)
      if (card === undefined) throw new Error(`测试画布缺少 ${kind} 卡片`)
      return card
    }
    const relationOf = (document: PlainDocument, relationId: string): PlainDocument => {
      const relations = document.relations
      if (!Array.isArray(relations)) throw new Error('测试画布缺少关联')
      const relation = (relations as PlainDocument[]).find((item) => item.relationId === relationId)
      if (relation === undefined) throw new Error(`测试画布缺少 ${relationId} 关联`)
      return relation
    }
    const expectDamaged = (document: PlainDocument, sourceVersion: 3 | 4): void => {
      expect(planCanvasArrangementMigration(document, IDENTITY, SOURCE_DIGEST)).toEqual({
        ok: false,
        reason: 'damaged',
        sourceVersion
      })
    }
    const v4Mutations: Array<(document: PlainDocument) => void> = [
      (document) => {
        ;(document.viewport as Record<string, number>).zoom = 0
      },
      (document) => {
        ;(cardOfKind(document, 'document').layout as Record<string, number>).width = 0
      },
      (document) => {
        cardOfKind(document, 'document').cardId = ' '
      },
      (document) => {
        cardOfKind(document, 'document').title = ' '
      },
      (document) => {
        cardOfKind(document, 'document').sourceId = ' '
      },
      (document) => {
        cardOfKind(document, 'animation').cardId = 'doc'
      },
      (document) => {
        ;(cardOfKind(document, 'animation').webgalPreset as Record<string, string>).command = ' '
      },
      (document) => {
        relationOf(document, 'rel').toCardId = 'prompt'
      },
      (document) => {
        relationOf(document, 'rel').toCardId = 'missing-card'
      },
      (document) => {
        ;(document.relations as PlainDocument[]).push({
          relationId: 'rel-2',
          fromCardId: 'doc',
          toCardId: 'prompt',
          specificName: '',
          recordCardId: null
        })
      },
      (document) => {
        ;(document.relations as PlainDocument[]).push({
          relationId: 'rel-2',
          fromCardId: 'img',
          toCardId: 'doc',
          specificName: '',
          recordCardId: null
        })
        relationOf(document, 'rel-2').relationId = 'rel'
      },
      (document) => {
        relationOf(document, 'rel').recordCardId = 'missing-card'
      },
      (document) => {
        relationOf(document, 'rel').recordCardId = 'anim'
      },
      (document) => {
        relationOf(document, 'rel').recordCardId = 'prompt'
        ;(document.relations as PlainDocument[]).push({
          relationId: 'rel-2',
          fromCardId: 'img',
          toCardId: 'doc',
          specificName: '',
          recordCardId: 'prompt'
        })
      },
      (document) => {
        cardOfKind(document, 'prompt').usage = { targetIds: [] }
      },
      (document) => {
        relationOf(document, 'rel').defaultRelation = 'actsOn'
      },
      (document) => {
        cardOfKind(document, 'prompt').title = '提示词标题'
      },
      (document) => {
        cardOfKind(document, 'prompt').references = [{ cardId: 'missing-card' }]
      },
      (document) => {
        cardOfKind(document, 'prompt').references = [{ cardId: 'img' }, { cardId: 'img' }]
      },
      (document) => {
        cardOfKind(document, 'prompt').references = [{ cardId: 'prompt' }]
      },
      (document) => {
        cardsOf(document).push({
          kind: 'prompt',
          cardId: 'other-prompt',
          body: '另一张提示词',
          references: [],
          layout: layout()
        })
        cardOfKind(document, 'prompt').references = [{ cardId: 'other-prompt' }]
      },
      (document) => {
        cardOfKind(document, 'prompt').references = [{ cardId: ' ' }]
      }
    ]
    for (const mutate of v4Mutations) {
      const document = structuredClone(v4Document()) as PlainDocument
      mutate(document)
      expectDamaged(document, 4)
    }

    const v3 = structuredClone(v3Document()) as PlainDocument
    ;(cardOfKind(v3, 'document').usage as Record<string, unknown>).characterId = ' '
    expectDamaged(v3, 3)
  })

  it('产品 manifest 镜像满足 R27 严格 v1 校验，并拒绝错位备份路径', () => {
    const projectRoot = resolve('/r28-canvas-manifest-project')
    const sceneKey = '7363656e652d31'
    const canvasKey = '63616e7661732d31'
    const relativePath = `.opengalgame/canvases/${sceneKey}/${canvasKey}.json`
    const batchId = 'b'.repeat(64)
    const batchRoot = resolve(projectRoot, '..', 'r28-canvas-backup', batchId)
    const manifest = createCanvasMigrationManifest({
      batchId,
      batchRoot,
      projectRoot,
      originalPath: join(projectRoot, ...relativePath.split('/')),
      relativePath,
      sizeBytes: 128,
      sha256: 'c'.repeat(64),
      modifiedAt: '2026-11-14T01:00:00.000Z',
      backedUpAt: '2026-11-14T02:00:00.000Z',
      createdAt: '2026-11-14T02:00:00.000Z'
    })
    expect(manifest.toolVersion).toBe(CANVAS_MIGRATION_TOOL_VERSION)
    expect(manifest.entries).toEqual([
      {
        family: 'canvas',
        originalPath: join(projectRoot, ...relativePath.split('/')),
        backupPath: `files/project-0/${relativePath}`,
        sizeBytes: 128,
        sha256: 'c'.repeat(64),
        modifiedAt: '2026-11-14T01:00:00.000Z',
        backedUpAt: '2026-11-14T02:00:00.000Z'
      }
    ])
    expect(() => r27.assertManifest(manifest)).not.toThrow()
    expect(assertCanvasMigrationManifest(manifest)).toEqual(manifest)

    const tampered = {
      ...manifest,
      entries: [{ ...manifest.entries[0]!, backupPath: `files/project-1/${relativePath}` }]
    }
    expect(() => r27.assertManifest(tampered)).toThrow()
    expect(() => assertCanvasMigrationManifest(tampered)).toThrow()
  })
})
