import { describe, expect, it } from 'vitest'

import { AppException } from '@common/errors/AppException'
import {
  SceneCanvasErrorCodes,
  type SceneCanvasErrorCode
} from '@domain/scene-canvas/errors/SceneCanvasErrorCodes'
import type {
  SceneCanvasArrangement,
  SceneCanvasCard,
  SceneCanvasCardLayout,
  SceneCanvasRelation
} from '@domain/scene-canvas/models/SceneCanvasArrangement'
import {
  bindSceneCanvasFieldPreset,
  copySceneCanvasCard,
  createSceneCanvasFieldCard,
  createSceneCanvasPromptCard,
  createSceneCanvasSourceCard,
  deleteSceneCanvasCard,
  editSceneCanvasCard,
  editSceneCanvasPromptBody
} from '@domain/scene-canvas/services/editSceneCanvasCards'
import {
  attachSceneCanvasRelationRecord,
  connectSceneCanvasCards,
  detachSceneCanvasRelationRecord,
  disconnectSceneCanvasCards,
  editSceneCanvasRelationName
} from '@domain/scene-canvas/services/editSceneCanvasRelations'
import { validateSceneCanvasArrangement } from '@domain/scene-canvas/services/validateSceneCanvasArrangement'

function expectCode(run: () => unknown, code: SceneCanvasErrorCode): void {
  try {
    run()
  } catch (error) {
    expect(error).toBeInstanceOf(AppException)
    expect(error).toMatchObject({ code })
    return
  }
  throw new Error(`expected AppException ${code}`)
}

function layout(patch: Partial<SceneCanvasCardLayout> = {}): SceneCanvasCardLayout {
  return { x: 12, y: -4, width: 160, height: 90, ...patch }
}

function arrangement(
  cards: readonly SceneCanvasCard[] = [],
  relations: readonly SceneCanvasRelation[] = []
): SceneCanvasArrangement {
  return {
    projectId: 'project-1',
    sceneId: 'scene-1',
    canvasId: 'canvas-1',
    viewport: { x: 0, y: 0, zoom: 1 },
    cards,
    relations
  }
}

function documentCard(cardId = 'doc', sourceId = 'source-doc'): SceneCanvasCard {
  return {
    kind: 'document',
    cardId,
    sourceId,
    title: '设定',
    summary: '',
    layout: layout()
  }
}

function cardsOfEveryKind(): SceneCanvasCard[] {
  return [
    documentCard('document'),
    { kind: 'prompt', cardId: 'prompt', body: '', layout: layout() },
    {
      kind: 'image',
      cardId: 'image',
      sourceId: 'source-image',
      role: 'background',
      title: '图',
      summary: '',
      layout: layout()
    },
    {
      kind: 'audio',
      cardId: 'audio',
      sourceId: 'source-audio',
      role: 'music',
      title: '声',
      summary: '',
      layout: layout()
    },
    {
      kind: 'video',
      cardId: 'video',
      sourceId: 'source-video',
      title: '影',
      summary: '',
      layout: layout()
    },
    { kind: 'animation', cardId: 'animation', webgalPreset: null, layout: layout() },
    { kind: 'effect', cardId: 'effect', webgalPreset: null, layout: layout() }
  ]
}

describe('场景画布编排规则', () => {
  it('允许空提示词、未绑定预设和同一来源的多张卡片', () => {
    const draft = arrangement([
      documentCard('doc-a', 'same-source'),
      documentCard('doc-b', 'same-source'),
      { kind: 'prompt', cardId: 'prompt', body: '', layout: layout() },
      { kind: 'animation', cardId: 'animation', webgalPreset: null, layout: layout() }
    ])

    expect(() => validateSceneCanvasArrangement(draft)).not.toThrow()
  })

  it('来源缺失不使已有卡片非法', () => {
    expect(() => validateSceneCanvasArrangement(arrangement([documentCard()]))).not.toThrow()
  })

  it('拒绝空标题、空白预设和非法布局', () => {
    expectCode(
      () =>
        validateSceneCanvasArrangement(
          arrangement([{ ...documentCard(), title: '  ' } as SceneCanvasCard])
        ),
      SceneCanvasErrorCodes.invalidField
    )
    expectCode(
      () =>
        validateSceneCanvasArrangement(
          arrangement([
            {
              kind: 'effect',
              cardId: 'effect',
              webgalPreset: { command: ' ', name: '闪白' },
              layout: layout()
            }
          ])
        ),
      SceneCanvasErrorCodes.invalidField
    )
    expectCode(
      () =>
        validateSceneCanvasArrangement(
          arrangement([{ ...documentCard(), layout: layout({ width: 0 }) }])
        ),
      SceneCanvasErrorCodes.invalidField
    )
    expectCode(
      () =>
        validateSceneCanvasArrangement({
          ...arrangement(),
          viewport: { x: 0, y: 0, zoom: 0 }
        }),
      SceneCanvasErrorCodes.invalidField
    )
  })

  it('拒绝重复身份和悬空引用', () => {
    expectCode(
      () =>
        validateSceneCanvasArrangement(arrangement([documentCard('same'), documentCard('same')])),
      SceneCanvasErrorCodes.identityConflict
    )
    expectCode(
      () =>
        validateSceneCanvasArrangement(
          arrangement(
            [
              documentCard('doc'),
              { kind: 'prompt', cardId: 'prompt', body: 'x', layout: layout() }
            ],
            [
              {
                relationId: 'rel',
                fromCardId: 'doc',
                toCardId: 'missing',
                specificName: '',
                recordCardId: null
              }
            ]
          )
        ),
      SceneCanvasErrorCodes.targetMissing
    )
  })

  it('任意类别都可以连接，反向连线视为重复', () => {
    const cards = cardsOfEveryKind()
    let draft = arrangement(cards)
    let index = 0
    for (let left = 0; left < cards.length; left += 1) {
      for (let right = left + 1; right < cards.length; right += 1) {
        draft = connectSceneCanvasCards(
          draft,
          `rel-${index}`,
          cards[left]!.cardId,
          cards[right]!.cardId
        )
        index += 1
      }
    }
    expect(draft.relations).toHaveLength(index)
    const original = structuredClone(draft)
    expectCode(
      () => connectSceneCanvasCards(draft, 'again', 'effect', 'document'),
      SceneCanvasErrorCodes.duplicateRelation
    )
    expect(draft).toEqual(original)
    expectCode(
      () => connectSceneCanvasCards(arrangement([documentCard('only')]), 'self', 'only', 'only'),
      SceneCanvasErrorCodes.selfConnection
    )
  })

  it('记录卡可以兼任端点，提示词记录只能装载一次', () => {
    const cards = [
      documentCard('doc'),
      { kind: 'prompt', cardId: 'prompt', body: '关系说明', layout: layout() },
      {
        kind: 'image',
        cardId: 'image',
        sourceId: 'source-image',
        role: 'background',
        title: '图',
        summary: '',
        layout: layout()
      }
    ]
    const linked = connectSceneCanvasCards(
      connectSceneCanvasCards(arrangement(cards), 'rel-a', 'doc', 'prompt'),
      'rel-b',
      'image',
      'doc'
    )
    const withRecord = attachSceneCanvasRelationRecord(linked, 'rel-a', 'prompt')
    expect(withRecord.relations.find((item) => item.relationId === 'rel-a')?.recordCardId).toBe(
      'prompt'
    )
    const replaced = attachSceneCanvasRelationRecord(withRecord, 'rel-a', 'doc')
    expect(replaced.relations.find((item) => item.relationId === 'rel-a')?.recordCardId).toBe('doc')
    const shared = attachSceneCanvasRelationRecord(replaced, 'rel-b', 'doc')
    expect(shared.relations.filter((item) => item.recordCardId === 'doc')).toHaveLength(2)
    expectCode(
      () => attachSceneCanvasRelationRecord(withRecord, 'rel-b', 'prompt'),
      SceneCanvasErrorCodes.promptRecordOccupied
    )
    expectCode(
      () => attachSceneCanvasRelationRecord(linked, 'rel-a', 'image'),
      SceneCanvasErrorCodes.invalidRecordKind
    )
  })

  it('复制不带关联，删除先清端点再卸记录', () => {
    const cards = [
      documentCard('doc'),
      { kind: 'prompt', cardId: 'prompt', body: '正文', layout: layout() },
      {
        kind: 'image',
        cardId: 'image',
        sourceId: 'source-image',
        role: 'background',
        title: '图',
        summary: '',
        layout: layout()
      }
    ]
    const linked = attachSceneCanvasRelationRecord(
      connectSceneCanvasCards(
        connectSceneCanvasCards(arrangement(cards), 'rel-end', 'doc', 'image'),
        'rel-record',
        'image',
        'prompt'
      ),
      'rel-record',
      'doc'
    )
    const copied = copySceneCanvasCard(linked, 'doc', 'doc-copy', layout({ x: 40 }))
    expect(copied.cards.map((card) => card.cardId)).toContain('doc-copy')
    expect(copied.relations).toEqual(linked.relations)
    expect(
      copied.relations.some(
        (relation) => relation.fromCardId === 'doc-copy' || relation.toCardId === 'doc-copy'
      )
    ).toBe(false)

    const deleted = deleteSceneCanvasCard(linked, 'doc')
    expect(deleted.cards.map((card) => card.cardId)).not.toContain('doc')
    expect(deleted.relations.map((relation) => relation.relationId)).toEqual(['rel-record'])
    expect(deleted.relations[0]?.recordCardId).toBeNull()
  })

  it('字段只接受该类别拥有的内容，失败不改原稿', () => {
    const draft = arrangement([
      documentCard(),
      { kind: 'prompt', cardId: 'prompt', body: '旧正文', layout: layout() },
      { kind: 'animation', cardId: 'animation', webgalPreset: null, layout: layout() }
    ])
    const original = structuredClone(draft)
    expectCode(
      () => editSceneCanvasCard(draft, 'prompt', { title: '标题' }),
      SceneCanvasErrorCodes.fieldNotApplicable
    )
    expectCode(
      () => editSceneCanvasCard(draft, 'animation', { title: '手输' }),
      SceneCanvasErrorCodes.fieldNotApplicable
    )
    expectCode(
      () => editSceneCanvasPromptBody(draft, 'doc', '正文'),
      SceneCanvasErrorCodes.fieldNotApplicable
    )
    const edited = editSceneCanvasCard(draft, 'doc', { title: '  新标题  ', summary: '' })
    expect(edited.cards[0]).toMatchObject({ title: '新标题', summary: '' })
    const bound = bindSceneCanvasFieldPreset(draft, 'animation', {
      command: ' setAnimation ',
      name: ' 淡入 '
    })
    expect(bound.cards.find((card) => card.cardId === 'animation')).toMatchObject({
      webgalPreset: { command: 'setAnimation', name: '淡入' }
    })
    expect(draft).toEqual(original)
  })

  it('图片和视频可以改用途说明，提示词和字段卡仍拒绝，空说明合法', () => {
    const draft = arrangement([
      {
        kind: 'image',
        cardId: 'image',
        sourceId: 'source-image',
        role: 'background',
        title: '图',
        summary: '旧说明',
        layout: layout()
      },
      {
        kind: 'video',
        cardId: 'video',
        sourceId: 'source-video',
        title: '影',
        summary: '旧说明',
        layout: layout()
      },
      { kind: 'prompt', cardId: 'prompt', body: '正文', layout: layout() },
      { kind: 'effect', cardId: 'effect', webgalPreset: null, layout: layout() }
    ])
    const original = structuredClone(draft)
    const image = editSceneCanvasCard(draft, 'image', { summary: '  屋顶夜景  ' })
    expect(image.cards.find((card) => card.cardId === 'image')).toMatchObject({
      summary: '  屋顶夜景  '
    })
    const video = editSceneCanvasCard(image, 'video', { summary: '' })
    expect(video.cards.find((card) => card.cardId === 'video')).toMatchObject({ summary: '' })
    expect(() => validateSceneCanvasArrangement(video)).not.toThrow()
    expectCode(
      () => editSceneCanvasCard(draft, 'prompt', { summary: '说明' }),
      SceneCanvasErrorCodes.fieldNotApplicable
    )
    expectCode(
      () => editSceneCanvasCard(draft, 'effect', { summary: '说明' }),
      SceneCanvasErrorCodes.fieldNotApplicable
    )
    expect(draft).toEqual(original)
  })

  it('创建卡片使用调用方给出的新身份', () => {
    const created = createSceneCanvasPromptCard(arrangement(), {
      kind: 'prompt',
      cardId: 'prompt-1',
      body: '',
      layout: layout()
    })
    expect(created.cards).toEqual([
      { kind: 'prompt', cardId: 'prompt-1', body: '', references: [], layout: layout() }
    ])
    const field = createSceneCanvasFieldCard(created, {
      kind: 'effect',
      cardId: 'effect-1',
      webgalPreset: null,
      layout: layout()
    })
    expect(field.cards.map((card) => card.cardId)).toEqual(['prompt-1', 'effect-1'])
    const source = createSceneCanvasSourceCard(field, documentCard('doc-1'))
    expect(source.cards).toHaveLength(3)
  })

  it('卸下记录和断开关联都不删除卡片', () => {
    const linked = attachSceneCanvasRelationRecord(
      connectSceneCanvasCards(
        arrangement([
          documentCard('doc'),
          { kind: 'prompt', cardId: 'prompt', body: '', layout: layout() }
        ]),
        'rel',
        'doc',
        'prompt'
      ),
      'rel',
      'prompt'
    )
    const detached = detachSceneCanvasRelationRecord(linked, 'rel')
    expect(detached.relations[0]?.recordCardId).toBeNull()
    expect(detached.cards).toHaveLength(2)
    const disconnected = disconnectSceneCanvasCards(linked, 'rel')
    expect(disconnected.relations).toEqual([])
    expect(disconnected.cards).toHaveLength(2)
    const renamed = editSceneCanvasRelationName(linked, 'rel', '  青梅竹马  ')
    expect(renamed.relations[0]?.specificName).toBe('青梅竹马')
  })

  it('旧提示词缺省引用仍合法，重命名不改变引用身份', () => {
    const legacy = arrangement([
      documentCard('doc'),
      { kind: 'prompt', cardId: 'prompt', body: '旧正文', layout: layout() }
    ])
    expect(() => validateSceneCanvasArrangement(legacy)).not.toThrow()

    const renamed = editSceneCanvasCard(
      arrangement([
        documentCard('doc'),
        {
          kind: 'prompt',
          cardId: 'prompt',
          body: '引用',
          references: [{ cardId: 'doc' }],
          layout: layout()
        }
      ]),
      'doc',
      { title: '新标题' }
    )
    expect(renamed.cards.find((card) => card.cardId === 'prompt')).toMatchObject({
      references: [{ cardId: 'doc' }]
    })
    expect(renamed.cards.find((card) => card.cardId === 'doc')).toMatchObject({ title: '新标题' })
  })

  it('提示词引用必须指向当前画布卡片，重复引用按身份拒绝', () => {
    const cards = [
      documentCard('doc'),
      {
        kind: 'image',
        cardId: 'image',
        sourceId: 'source-image',
        role: 'characterImage' as const,
        title: '人物',
        summary: '',
        layout: layout()
      }
    ]
    expect(() =>
      validateSceneCanvasArrangement(
        arrangement([
          ...cards,
          {
            kind: 'prompt',
            cardId: 'prompt',
            body: '用这张图',
            references: [{ cardId: 'image' }],
            layout: layout()
          }
        ])
      )
    ).not.toThrow()
    expectCode(
      () =>
        validateSceneCanvasArrangement(
          arrangement([
            ...cards,
            {
              kind: 'prompt',
              cardId: 'prompt',
              body: '引用自己',
              references: [{ cardId: 'prompt' }],
              layout: layout()
            }
          ])
        ),
      SceneCanvasErrorCodes.targetMissing
    )
    expectCode(
      () =>
        validateSceneCanvasArrangement(
          arrangement([
            ...cards,
            {
              kind: 'prompt',
              cardId: 'prompt',
              body: '引用重复',
              references: [{ cardId: 'doc' }, { cardId: 'doc' }],
              layout: layout()
            }
          ])
        ),
      SceneCanvasErrorCodes.identityConflict
    )
    expectCode(
      () =>
        validateSceneCanvasArrangement(
          arrangement([
            ...cards,
            {
              kind: 'prompt',
              cardId: 'prompt',
              body: '引用缺失',
              references: [{ cardId: 'missing' }],
              layout: layout()
            }
          ])
        ),
      SceneCanvasErrorCodes.targetMissing
    )
    expectCode(
      () =>
        validateSceneCanvasArrangement(
          arrangement([
            ...cards,
            {
              kind: 'prompt',
              cardId: 'prompt',
              body: '引用空白',
              references: [{ cardId: ' ' }],
              layout: layout()
            }
          ])
        ),
      SceneCanvasErrorCodes.invalidField
    )
  })

  it('提示词不能引用另一张提示词卡', () => {
    expectCode(
      () =>
        validateSceneCanvasArrangement(
          arrangement([
            documentCard('doc'),
            {
              kind: 'prompt',
              cardId: 'other-prompt',
              body: '另一张提示词',
              references: [],
              layout: layout()
            },
            {
              kind: 'prompt',
              cardId: 'prompt',
              body: '引用提示词',
              references: [{ cardId: 'other-prompt' }],
              layout: layout()
            }
          ])
        ),
      SceneCanvasErrorCodes.targetMissing
    )
  })

  it('删除被引用卡片时卸下提示词引用，不按标题替换', () => {
    const draft = arrangement([
      documentCard('doc'),
      documentCard('same-title'),
      {
        kind: 'prompt',
        cardId: 'prompt',
        body: '引用文档',
        references: [{ cardId: 'doc' }],
        layout: layout()
      }
    ])
    const deleted = deleteSceneCanvasCard(draft, 'doc')
    expect(deleted.cards.find((card) => card.cardId === 'prompt')).toMatchObject({
      references: []
    })
    expect(deleted.cards.map((card) => card.cardId)).toEqual(['same-title', 'prompt'])
  })
})
