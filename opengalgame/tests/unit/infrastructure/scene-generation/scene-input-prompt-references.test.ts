import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { ErrorCodes } from '@common/errors/ErrorCodes'
import { FailureReasons } from '@common/errors/FailureReasons'
import { SceneCanvasErrorCodes } from '@common/errors/SceneCanvasErrorCodes'
import { ProjectFileErrorCodes } from '@domain/project-files/errors/ProjectFileErrorCodes'
import { SceneInputGatewayImpl } from '@infrastructure/scene-generation/inputs/SceneInputGatewayImpl'
import { CanvasArrangementMigration } from '@infrastructure/scene-canvas/migration/CanvasArrangementMigration'
import { planCanvasArrangementMigration } from '@infrastructure/scene-canvas/migration/canvasArrangementMigrationPlan'
import { SCENE_CANVAS_ARRANGEMENT_FORMAT_VERSION } from '@infrastructure/scene-canvas/documents/SceneCanvasArrangementDocument'
import { PROJECT_ARRANGEMENT_FORMAT_VERSION } from '@infrastructure/scene-canvas/migration/legacy/documents/LegacySceneCanvasArrangementDocument'
import {
  documentBodyPath,
  encodeStorageKey,
  sourceDescriptorPath
} from '@infrastructure/project-files/public/projectFileStorage'
import { arrangementPath } from '@infrastructure/scene-canvas/sceneCanvasPaths'

const PNG = Buffer.from(
  '89504e470d0a1a0a0000000d4948445200000001000000010802000000907753de0000000c4944415408d763f8cfc0000000020001e221bc330000000049454e44ae426082',
  'hex'
)
const WAV = Buffer.concat([
  Buffer.from('RIFF'),
  Buffer.from([36, 0, 0, 0]),
  Buffer.from('WAVEfmt '),
  Buffer.from([16, 0, 0, 0, 1, 0, 1, 0, 68, 172, 0, 0, 136, 88, 1, 0, 2, 0, 16, 0]),
  Buffer.from('data'),
  Buffer.from([4, 0, 0, 0, 0, 0, 0, 0])
])
const MP4 = Buffer.concat([
  Buffer.from([0, 0, 0, 24]),
  Buffer.from('ftypisom'),
  Buffer.from([0, 0, 0, 0]),
  Buffer.from('isommp41')
])
const directories: string[] = []

type PromptCardRecord = {
  kind: 'prompt'
  cardId: string
  body: string
  layout: { x: number; y: number; width: number; height: number }
  references?: readonly { cardId: string }[]
}

type RegisteredSource = {
  projectId: string
  sceneId: string
  projectRoot: string
  sceneDirectory: string
  entryFile: string
}

afterEach(async () => {
  for (const directory of directories.splice(0)) {
    await rm(directory, { recursive: true, force: true })
  }
})

describe('提示词卡片引用进入生成输入', () => {
  it('旧记录引用为空，有效引用保留 cardId、显示名和卡片类别', async () => {
    const root = await temporaryProject()
    await writeArrangement(root, promptCard())
    const legacy = await gateway(root).readInputs(source(root), selection())
    expect(legacy.prompts[0]).toMatchObject({ references: [] })
    expect(legacy.assets.map((asset) => asset.category)).toEqual(['image'])

    await writeArrangement(
      root,
      promptCard([{ cardId: 'image-card' }, { cardId: 'document-card' }])
    )
    const inputs = await gateway(root).readInputs(source(root), selection())
    expect(inputs.prompts).toEqual([
      expect.objectContaining({
        id: 'prompt-card',
        body: '用人物作立绘，用声音作配音',
        references: [
          {
            cardId: 'image-card',
            kind: 'image',
            displayName: '人物'
          },
          { cardId: 'document-card', kind: 'document', displayName: '设定' }
        ]
      })
    ])
    expect(inputs.assets.find((asset) => asset.assetId === 'image-card')?.category).toBe('image')
    expect(JSON.parse(JSON.stringify(inputs)).prompts[0].references).toEqual(
      inputs.prompts[0]?.references
    )
  })

  it('重命名后仍按 cardId 读取新显示名，不按标题替换', async () => {
    const root = await temporaryProject()
    await writeArrangement(root, promptCard([{ cardId: 'image-card' }]), { imageTitle: '新人物' })
    const inputs = await gateway(root).readInputs(source(root), selection())
    expect(inputs.prompts[0]?.references).toEqual([
      { cardId: 'image-card', kind: 'image', displayName: '新人物' }
    ])
    expect(inputs.prompts[0]?.references[0]).not.toHaveProperty('role')
    expect(inputs.assets.some((asset) => asset.name === '人物')).toBe(false)
  })

  it('删除、不可读或离开当前画布的引用明确失败', async () => {
    const root = await temporaryProject()
    await writeArrangement(root, promptCard([{ cardId: 'missing-card' }]))
    await expect(gateway(root).readInputs(source(root), selection())).rejects.toMatchObject({
      message: '提示词引用的卡片不在当前画布或无法读取',
      reason: FailureReasons.promptReferenceTargetMissing
    })

    await writeArrangement(root, promptCard([{ cardId: 'image-card' }, { cardId: 'image-card' }]))
    await expect(gateway(root).readInputs(source(root), selection())).rejects.toMatchObject({
      message: '同一提示词不能重复引用同一卡片',
      reason: FailureReasons.promptReferenceDuplicate
    })

    await writeArrangement(root, promptCard([{ cardId: 'image-card' }]))
    await writeFile(join(root, sourceDescriptorPath('image-source')), '{', 'utf8')
    await expect(gateway(root).readInputs(source(root), selection())).rejects.toMatchObject({
      message: '工程文件内容损坏'
    })
  })

  it('引用另一张提示词卡时按现有 4101 规则失败', async () => {
    const root = await temporaryProject()
    await writeArrangement(
      root,
      promptCard([{ cardId: 'other-prompt' }]),
      {},
      {
        kind: 'prompt',
        cardId: 'other-prompt',
        body: '另一张提示词',
        references: [],
        layout: { x: 40, y: 0, width: 10, height: 10 }
      }
    )
    await expect(gateway(root).readInputs(source(root), selection())).rejects.toMatchObject({
      code: 4101,
      message: '提示词引用的卡片不在当前画布或无法读取',
      reason: FailureReasons.promptReferenceTargetMissing
    })
  })

  it('图片、音频和视频的生成说明取卡片用途，类别由卡片种类给出，两种格式缺字段都为空', async () => {
    const root = await temporaryProject()
    await writeAsset(root, 'audio-source', 'audio', WAV, 'night.wav')
    await writeAsset(root, 'video-source', 'video', MP4, 'opening.mp4')
    await writeMediaArrangement(root, SCENE_CANVAS_ARRANGEMENT_FORMAT_VERSION, {
      image: '屋顶夜景',
      audio: '缓慢的夜间氛围',
      video: '开场镜头'
    })
    const current = await gateway(root).readInputs(source(root), selection())
    expect(current.assets.map((asset) => [asset.assetId, asset.category])).toEqual([
      ['image-card', 'image'],
      ['audio-card', 'audio'],
      ['video-card', 'video']
    ])
    expect(current.assets.every((asset) => !('purpose' in asset))).toBe(true)
    expect(current.assets.map((asset) => [asset.assetId, asset.description])).toEqual([
      ['image-card', '屋顶夜景'],
      ['audio-card', '缓慢的夜间氛围'],
      ['video-card', '开场镜头']
    ])

    await writeMediaArrangement(root, SCENE_CANVAS_ARRANGEMENT_FORMAT_VERSION)
    const missingCurrent = await gateway(root).readInputs(source(root), selection())
    expect(missingCurrent.assets.map((asset) => asset.description)).toEqual(['', '', ''])

    await writeMediaArrangement(root, 4)
    const missingLegacyV4 = await gateway(root).readInputs(source(root), selection())
    expect(missingLegacyV4.assets.map((asset) => asset.description)).toEqual(['', '', ''])

    await writeMediaArrangement(root, PROJECT_ARRANGEMENT_FORMAT_VERSION)
    const missingLegacy = await gateway(root).readInputs(source(root), selection())
    expect(missingLegacy.assets.map((asset) => asset.description)).toEqual(['', '', ''])

    await writeMediaArrangement(root, PROJECT_ARRANGEMENT_FORMAT_VERSION, {
      image: '格式三图片说明',
      audio: '格式三音频说明',
      video: '格式三视频说明'
    })
    const legacy = await gateway(root).readInputs(source(root), selection())
    expect(legacy.assets.map((asset) => [asset.assetId, asset.description])).toEqual([
      ['image-card', '格式三图片说明'],
      ['audio-card', '格式三音频说明'],
      ['video-card', '格式三视频说明']
    ])
    expect(legacy.fieldBindings).toEqual([])
  })

  it('当前 v5 坏数据按 4416 拒绝，归属错误按 4418 拒绝', async () => {
    const root = await temporaryProject()
    await writeArrangement(root, promptCard())
    const relativePath = arrangementPath('scene-1', 'canvas-1')
    const document = JSON.parse(await readFile(join(root, relativePath), 'utf8')) as {
      projectId: string
      viewport: { zoom: number }
    }
    document.viewport.zoom = 0
    await writeRelative(root, relativePath, JSON.stringify(document))
    await expect(gateway(root).readInputs(source(root), selection())).rejects.toMatchObject({
      code: SceneCanvasErrorCodes.contentDamaged,
      message: '编排内容损坏'
    })

    document.viewport.zoom = 1
    document.projectId = 'other-project'
    await writeRelative(root, relativePath, JSON.stringify(document))
    await expect(gateway(root).readInputs(source(root), selection())).rejects.toMatchObject({
      code: SceneCanvasErrorCodes.ownershipMismatch,
      message: '工程文件归属不匹配'
    })
  })
})

describe('当前与旧画布字段进入生成输入的基线（G07）', () => {
  it('v4（字面量 4）：源卡片 title/summary 保留，prompt 标题与全部 usage/defaultRelation 是读取默认值', async () => {
    const root = await temporaryProject()
    const document = await writeFieldArrangement(root, 4)
    const inputs = await gateway(root).readInputs(source(root), selection())
    const { arrangementVersion, ...dto } = inputs

    expect(dto).toEqual({
      canvasId: 'canvas-1',
      assets: [
        {
          assetId: 'image-card',
          sourceId: 'image-source',
          name: '人物标题',
          relativePath: 'assets/character.png',
          category: 'image',
          description: '人物摘要',
          usage: { targetIds: [] }
        }
      ],
      documents: [
        {
          id: 'document-card',
          sourceId: 'document-source',
          title: '设定标题',
          summary: '设定摘要',
          body: '设定正文',
          topics: ['角色'],
          usage: { targetIds: [] }
        }
      ],
      prompts: [
        {
          id: 'prompt-card',
          title: 'prompt-card',
          body: '提示词正文',
          scopes: [{ kind: 'cards', cardIds: ['image-card'] }],
          references: [{ cardId: 'image-card', kind: 'image', displayName: '人物标题' }],
          usage: { targetIds: [] }
        }
      ],
      fieldBindings: [
        {
          cardId: 'animation-card',
          kind: 'animation',
          command: 'setAnimation',
          name: '淡入',
          usage: { targetIds: [] }
        },
        {
          cardId: 'effect-card',
          kind: 'effect',
          command: null,
          name: null,
          usage: { targetIds: [] }
        }
      ],
      relations: [
        {
          relationId: 'rel-prompt',
          fromCardId: 'prompt-card',
          toCardId: 'image-card',
          defaultRelation: 'associated',
          specificName: '挥手',
          record: null
        },
        {
          relationId: 'rel-document',
          fromCardId: 'document-card',
          toCardId: 'image-card',
          defaultRelation: 'associated',
          specificName: '约束',
          record: { kind: 'document', cardId: 'document-card', sourceId: 'document-source' }
        }
      ],
      confirmedControls: []
    })
    await expectArrangementVersionTracksCanvasFile(root, document, arrangementVersion)
  })

  it('旧 v3：title/summary/usage/defaultRelation/references/relations 按真实保存值进入生成输入', async () => {
    const root = await temporaryProject()
    const document = await writeFieldArrangement(root, PROJECT_ARRANGEMENT_FORMAT_VERSION)
    const inputs = await gateway(root).readInputs(source(root), selection())
    const { arrangementVersion, ...dto } = inputs

    expect(dto).toEqual({
      canvasId: 'canvas-1',
      assets: [
        {
          assetId: 'image-card',
          sourceId: 'image-source',
          name: '人物标题',
          relativePath: 'assets/character.png',
          category: 'image',
          description: '人物摘要',
          usage: { characterId: 'char-2', targetIds: ['document-card'] }
        }
      ],
      documents: [
        {
          id: 'document-card',
          sourceId: 'document-source',
          title: '设定标题',
          summary: '设定摘要',
          body: '设定正文',
          topics: ['角色'],
          usage: {
            characterId: 'char-1',
            locationId: 'loc-1',
            spokenLine: '设定台词',
            targetIds: ['image-card']
          }
        }
      ],
      prompts: [
        {
          id: 'prompt-card',
          title: '提示词标题',
          body: '提示词正文',
          scopes: [{ kind: 'cards', cardIds: ['image-card'] }],
          references: [{ cardId: 'image-card', kind: 'image', displayName: '人物标题' }],
          usage: { locationId: 'loc-2', spokenLine: '提示词台词', targetIds: ['image-card'] }
        }
      ],
      fieldBindings: [
        {
          cardId: 'animation-card',
          kind: 'animation',
          command: 'setAnimation',
          name: '淡入',
          usage: { targetIds: ['effect-card'] }
        },
        {
          cardId: 'effect-card',
          kind: 'effect',
          command: null,
          name: null,
          usage: { targetIds: [] }
        }
      ],
      relations: [
        {
          relationId: 'rel-prompt',
          fromCardId: 'prompt-card',
          toCardId: 'image-card',
          defaultRelation: 'actsOn',
          specificName: '挥手',
          record: null
        },
        {
          relationId: 'rel-document',
          fromCardId: 'document-card',
          toCardId: 'image-card',
          defaultRelation: 'constrains',
          specificName: '约束',
          record: { kind: 'document', cardId: 'document-card', sourceId: 'document-source' }
        }
      ],
      confirmedControls: []
    })
    await expectArrangementVersionTracksCanvasFile(root, document, arrangementVersion)
  })

  it('旧 v3 使用设置为空由迁移工具判非法，产品按旧格式不支持拒绝', async () => {
    const root = await temporaryProject()
    const document = await writeFieldArrangement(root, 3)
    const cards = document.cards as Record<string, unknown>[]
    const documentCard = cards.find((card) => card.cardId === 'document-card')
    if (documentCard === undefined) throw new Error('测试画布缺少文档卡')
    const usage = documentCard.usage as Record<string, unknown>
    usage.characterId = ' '
    expect(
      planCanvasArrangementMigration(
        document,
        { projectId: 'project-1', sceneId: 'scene-1', canvasId: 'canvas-1' },
        'a'.repeat(64)
      )
    ).toEqual({ ok: false, reason: 'damaged', sourceVersion: 3 })
    await writeRelative(root, arrangementPath('scene-1', 'canvas-1'), JSON.stringify(document))
    await expect(gateway(root).readInputs(source(root), selection())).rejects.toMatchObject({
      code: SceneCanvasErrorCodes.unsupportedFormat,
      message: '编排格式不受支持'
    })
  })

  it('当前 v5：真实 title/summary/usage/defaultRelation/references/relations 与旧 v3 等价进入生成输入', async () => {
    const currentRoot = await temporaryProject()
    const currentDocument = await writeFieldArrangement(
      currentRoot,
      SCENE_CANVAS_ARRANGEMENT_FORMAT_VERSION
    )
    const legacyRoot = await temporaryProject()
    await writeFieldArrangement(legacyRoot, PROJECT_ARRANGEMENT_FORMAT_VERSION)

    const currentInputs = await gateway(currentRoot).readInputs(source(currentRoot), selection())
    const legacyInputs = await gateway(legacyRoot).readInputs(source(legacyRoot), selection())
    const { arrangementVersion: currentVersion, ...currentDto } = currentInputs
    const legacyDto = Object.fromEntries(
      Object.entries(legacyInputs).filter(([key]) => key !== 'arrangementVersion')
    )

    expect(currentDto).toEqual(legacyDto)
    expect(currentInputs.prompts[0]?.title).toBe('提示词标题')
    expect(currentInputs.prompts[0]?.usage).toEqual({
      locationId: 'loc-2',
      spokenLine: '提示词台词',
      targetIds: ['image-card']
    })
    expect(currentInputs.documents[0]?.usage).toEqual({
      characterId: 'char-1',
      locationId: 'loc-1',
      spokenLine: '设定台词',
      targetIds: ['image-card']
    })
    expect(currentInputs.fieldBindings[0]?.usage).toEqual({ targetIds: ['effect-card'] })
    expect(currentInputs.relations.map((relation) => relation.defaultRelation)).toEqual([
      'actsOn',
      'constrains'
    ])
    await expectArrangementVersionTracksCanvasFile(currentRoot, currentDocument, currentVersion)
  })

  it('v4 含 usage/defaultRelation 或 prompt title 时迁移工具判损坏，产品按旧格式拒绝', async () => {
    const root = await temporaryProject()
    const base = await writeFieldArrangement(root, 4)
    const relativePath = arrangementPath('scene-1', 'canvas-1')
    const cardOfKind = (
      document: Record<string, unknown>,
      kind: string
    ): Record<string, unknown> => {
      const cards = document.cards
      if (!Array.isArray(cards)) throw new Error('测试画布缺少卡片')
      const card = cards.find(
        (item): item is Record<string, unknown> =>
          item !== null &&
          typeof item === 'object' &&
          (item as Record<string, unknown>).kind === kind
      )
      if (card === undefined) throw new Error(`测试画布缺少 ${kind} 卡片`)
      return card
    }

    const withUsage = structuredClone(base)
    cardOfKind(withUsage, 'prompt').usage = { targetIds: [] }
    await writeRelative(root, relativePath, JSON.stringify(withUsage))
    await expect(gateway(root).readInputs(source(root), selection())).rejects.toMatchObject({
      code: SceneCanvasErrorCodes.unsupportedFormat,
      message: '编排格式不受支持'
    })

    const withDefaultRelation = structuredClone(base)
    const relations = withDefaultRelation.relations
    if (!Array.isArray(relations) || relations[0] === null || typeof relations[0] !== 'object') {
      throw new Error('测试画布缺少关联')
    }
    ;(relations[0] as Record<string, unknown>).defaultRelation = 'actsOn'
    await writeRelative(root, relativePath, JSON.stringify(withDefaultRelation))
    await expect(gateway(root).readInputs(source(root), selection())).rejects.toMatchObject({
      code: SceneCanvasErrorCodes.unsupportedFormat,
      message: '编排格式不受支持'
    })

    const withPromptTitle = structuredClone(base)
    cardOfKind(withPromptTitle, 'prompt').title = '提示词标题'
    await writeRelative(root, relativePath, JSON.stringify(withPromptTitle))
    await expect(gateway(root).readInputs(source(root), selection())).rejects.toMatchObject({
      code: SceneCanvasErrorCodes.unsupportedFormat,
      message: '编排格式不受支持'
    })
    expect(JSON.parse(await readFile(join(root, relativePath), 'utf8'))).toEqual(withPromptTitle)
  })
})

describe('旧 v4 生成输入错误码与引用顺序（R11）', () => {
  type PlainDocument = Record<string, unknown>

  function cardsOf(document: PlainDocument): PlainDocument[] {
    const cards = document.cards
    if (!Array.isArray(cards)) throw new Error('测试画布缺少卡片')
    return cards as PlainDocument[]
  }

  function cardOfKind(document: PlainDocument, kind: string): PlainDocument {
    const card = cardsOf(document).find((item) => item.kind === kind)
    if (card === undefined) throw new Error(`测试画布缺少 ${kind} 卡片`)
    return card
  }

  function relationOf(document: PlainDocument, relationId: string): PlainDocument {
    const relations = document.relations
    if (!Array.isArray(relations)) throw new Error('测试画布缺少关联')
    const relation = (relations as PlainDocument[]).find((item) => item.relationId === relationId)
    if (relation === undefined) throw new Error(`测试画布缺少 ${relationId} 关联`)
    return relation
  }

  it('schema 合法但领域非法的 v4 文件由迁移工具判损坏，产品统一按旧格式拒绝', async () => {
    const root = await temporaryProject()
    const base = await writeFieldArrangement(root, 4)
    const relativePath = arrangementPath('scene-1', 'canvas-1')
    const expectRejected = async (
      mutate: (document: PlainDocument) => void,
      _oldReadError: { code: number; message: string }
    ): Promise<void> => {
      void _oldReadError
      const document = structuredClone(base)
      mutate(document)
      expect(
        planCanvasArrangementMigration(
          document,
          { projectId: 'project-1', sceneId: 'scene-1', canvasId: 'canvas-1' },
          'a'.repeat(64)
        )
      ).toEqual({ ok: false, reason: 'damaged', sourceVersion: 4 })
      await writeRelative(root, relativePath, JSON.stringify(document))
      await expect(gateway(root).readInputs(source(root), selection())).rejects.toMatchObject({
        code: SceneCanvasErrorCodes.unsupportedFormat,
        message: '编排格式不受支持'
      })
      expect(JSON.parse(await readFile(join(root, relativePath), 'utf8'))).toEqual(document)
    }

    await expectRejected(
      (document) => {
        const viewport = document.viewport as Record<string, number>
        viewport.zoom = 0
      },
      { code: ProjectFileErrorCodes.invalidCardLayout, message: '画布视口无效' }
    )
    await expectRejected(
      (document) => {
        const layout = cardOfKind(document, 'document').layout as Record<string, number>
        layout.width = 0
      },
      { code: ProjectFileErrorCodes.invalidCardLayout, message: '卡片布局无效' }
    )
    await expectRejected(
      (document) => {
        cardOfKind(document, 'document').cardId = ' '
      },
      { code: ProjectFileErrorCodes.blankArrangementIdentity, message: '卡片身份不能为空' }
    )
    await expectRejected(
      (document) => {
        cardOfKind(document, 'document').title = ' '
      },
      { code: ProjectFileErrorCodes.blankArrangementIdentity, message: '卡片标题不能为空' }
    )
    await expectRejected(
      (document) => {
        cardOfKind(document, 'document').sourceId = ' '
      },
      { code: ProjectFileErrorCodes.blankCardSourceId, message: '卡片来源身份不能为空' }
    )
    await expectRejected(
      (document) => {
        cardOfKind(document, 'effect').cardId = 'document-card'
      },
      { code: ProjectFileErrorCodes.duplicateCardId, message: '同一编排不能重复登记同一卡片' }
    )
    await expectRejected(
      (document) => {
        const preset = cardOfKind(document, 'animation').webgalPreset as Record<string, string>
        preset.command = ' '
      },
      { code: ProjectFileErrorCodes.invalidCardBinding, message: '卡片字段绑定无效' }
    )
    await expectRejected(
      (document) => {
        relationOf(document, 'rel-prompt').toCardId = 'prompt-card'
      },
      { code: ProjectFileErrorCodes.invalidCardBinding, message: '卡片关联无效' }
    )
    await expectRejected(
      (document) => {
        relationOf(document, 'rel-prompt').toCardId = 'missing-card'
      },
      { code: ProjectFileErrorCodes.invalidCardBinding, message: '卡片关联无效' }
    )
    await expectRejected(
      (document) => {
        relationOf(document, 'rel-document').fromCardId = 'prompt-card'
      },
      { code: ProjectFileErrorCodes.invalidCardBinding, message: '卡片关联无效' }
    )
    await expectRejected(
      (document) => {
        relationOf(document, 'rel-document').relationId = 'rel-prompt'
      },
      { code: ProjectFileErrorCodes.invalidCardBinding, message: '卡片关联无效' }
    )
    await expectRejected(
      (document) => {
        relationOf(document, 'rel-document').recordCardId = 'missing-card'
      },
      { code: ProjectFileErrorCodes.invalidCardBinding, message: '卡片关联无效' }
    )
    await expectRejected(
      (document) => {
        relationOf(document, 'rel-document').recordCardId = 'animation-card'
      },
      { code: ProjectFileErrorCodes.invalidCardBinding, message: '卡片关联无效' }
    )
    await expectRejected(
      (document) => {
        relationOf(document, 'rel-prompt').recordCardId = 'prompt-card'
        relationOf(document, 'rel-document').recordCardId = 'prompt-card'
      },
      { code: ProjectFileErrorCodes.invalidCardBinding, message: '卡片关联无效' }
    )
  })

  it('v4 非法提示词引用由迁移工具判损坏，产品在读取来源前按旧格式拒绝', async () => {
    const root = await temporaryProject()
    const base = await writeFieldArrangement(root, 4)
    const relativePath = arrangementPath('scene-1', 'canvas-1')
    const expectRejected = async (
      mutate: (document: PlainDocument) => void,
      _oldReadError: { code: number; message: string; reason?: string }
    ): Promise<void> => {
      void _oldReadError
      const document = structuredClone(base)
      mutate(document)
      expect(
        planCanvasArrangementMigration(
          document,
          { projectId: 'project-1', sceneId: 'scene-1', canvasId: 'canvas-1' },
          'a'.repeat(64)
        )
      ).toEqual({ ok: false, reason: 'damaged', sourceVersion: 4 })
      await writeRelative(root, relativePath, JSON.stringify(document))
      await expect(gateway(root).readInputs(source(root), selection())).rejects.toMatchObject({
        code: SceneCanvasErrorCodes.unsupportedFormat,
        message: '编排格式不受支持'
      })
    }

    await expectRejected(
      (document) => {
        cardOfKind(document, 'prompt').references = [{ cardId: 'missing-card' }]
      },
      {
        code: ErrorCodes.invalidRequest,
        message: '提示词引用的卡片不在当前画布或无法读取',
        reason: FailureReasons.promptReferenceTargetMissing
      }
    )
    await expectRejected(
      (document) => {
        cardOfKind(document, 'prompt').references = [
          { cardId: 'image-card' },
          { cardId: 'image-card' }
        ]
      },
      {
        code: ErrorCodes.invalidRequest,
        message: '同一提示词不能重复引用同一卡片',
        reason: FailureReasons.promptReferenceDuplicate
      }
    )
    await expectRejected(
      (document) => {
        cardOfKind(document, 'prompt').references = [{ cardId: 'prompt-card' }]
      },
      {
        code: ErrorCodes.invalidRequest,
        message: '提示词引用的卡片不在当前画布或无法读取',
        reason: FailureReasons.promptReferenceTargetMissing
      }
    )
    await expectRejected(
      (document) => {
        cardsOf(document).push({
          kind: 'prompt',
          cardId: 'other-prompt',
          body: '另一张提示词',
          references: [],
          layout: { x: 0, y: 0, width: 10, height: 10 }
        })
        cardOfKind(document, 'prompt').references = [{ cardId: 'other-prompt' }]
      },
      {
        code: ErrorCodes.invalidRequest,
        message: '提示词引用的卡片不在当前画布或无法读取',
        reason: FailureReasons.promptReferenceTargetMissing
      }
    )
    await expectRejected(
      (document) => {
        cardOfKind(document, 'prompt').references = [{ cardId: ' ' }]
      },
      {
        code: ErrorCodes.invalidRequest,
        message: '提示词引用的卡片不在当前画布或无法读取',
        reason: FailureReasons.promptReferenceTargetMissing
      }
    )

    const document = structuredClone(base)
    cardOfKind(document, 'prompt').references = [{ cardId: 'missing-card' }]
    await writeRelative(root, relativePath, JSON.stringify(document))
    await writeFile(join(root, sourceDescriptorPath('image-source')), '{', 'utf8')
    await expect(gateway(root).readInputs(source(root), selection())).rejects.toMatchObject({
      code: SceneCanvasErrorCodes.unsupportedFormat,
      message: '编排格式不受支持'
    })
  })
})

function gateway(root: string): SceneInputGatewayImpl {
  const backupRoot = `${root}-migration`
  directories.push(backupRoot)
  return new SceneInputGatewayImpl(
    [{ source: source(root) }],
    new CanvasArrangementMigration({ backupRoot })
  )
}

function source(root: string): RegisteredSource {
  return {
    projectId: 'project-1',
    sceneId: 'scene-1',
    projectRoot: root,
    sceneDirectory: 'game/scene',
    entryFile: 'start.txt'
  }
}

function selection(): { canvasId: string; confirmedControls: [] } {
  return { canvasId: 'canvas-1', confirmedControls: [] }
}

function promptCard(references?: readonly { cardId: string }[]): PromptCardRecord {
  return {
    kind: 'prompt',
    cardId: 'prompt-card',
    body: '用人物作立绘，用声音作配音',
    ...(references === undefined ? {} : { references }),
    layout: { x: 0, y: 0, width: 100, height: 80 }
  }
}

async function temporaryProject(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'opengalgame-prompt-references-'))
  directories.push(root)
  await writeRelative(
    root,
    '.opengalgame/manifest.json',
    `${JSON.stringify({ formatVersion: 2, projectId: 'project-1', operationId: 'op-1' })}\n`
  )
  await writeDocument(root, 'document-source', '设定正文')
  await writeAsset(root, 'image-source', 'image', PNG, 'character.png')
  return root
}

async function writeArrangement(
  root: string,
  prompt: PromptCardRecord,
  titles: { imageTitle?: string } = {},
  extra?: PromptCardRecord
): Promise<void> {
  await writeRelative(
    root,
    arrangementPath('scene-1', 'canvas-1'),
    JSON.stringify({
      formatVersion: SCENE_CANVAS_ARRANGEMENT_FORMAT_VERSION,
      projectId: 'project-1',
      sceneId: 'scene-1',
      canvasId: 'canvas-1',
      viewport: { x: 0, y: 0, zoom: 1 },
      cards: [
        {
          kind: 'document',
          cardId: 'document-card',
          sourceId: 'document-source',
          title: '设定',
          summary: '',
          usage: { targetIds: [] },
          layout: { x: 0, y: 0, width: 10, height: 10 }
        },
        {
          kind: 'image',
          cardId: 'image-card',
          sourceId: 'image-source',
          role: 'characterImage',
          title: titles.imageTitle ?? '人物',
          summary: '人物立绘',
          usage: { targetIds: [] },
          layout: { x: 20, y: 0, width: 10, height: 10 }
        },
        { title: prompt.cardId, summary: '', usage: { targetIds: [] }, ...prompt },
        ...(extra === undefined
          ? []
          : [{ title: extra.cardId, summary: '', usage: { targetIds: [] }, ...extra }])
      ],
      relations: []
    })
  )
}

async function writeMediaArrangement(
  root: string,
  formatVersion: number,
  summaries: { image?: string; audio?: string; video?: string } = {}
): Promise<void> {
  const layout = { x: 0, y: 0, width: 10, height: 10 }
  const full =
    formatVersion === PROJECT_ARRANGEMENT_FORMAT_VERSION ||
    formatVersion === SCENE_CANVAS_ARRANGEMENT_FORMAT_VERSION
  const usage = full ? { usage: { targetIds: [] } } : {}
  const summaryOf = (value: string | undefined): { summary?: string } =>
    value === undefined && !full ? {} : { summary: value ?? '' }
  await writeRelative(
    root,
    arrangementPath('scene-1', 'canvas-1'),
    JSON.stringify({
      formatVersion,
      projectId: 'project-1',
      sceneId: 'scene-1',
      canvasId: 'canvas-1',
      viewport: { x: 0, y: 0, zoom: 1 },
      cards: [
        {
          kind: 'image',
          cardId: 'image-card',
          sourceId: 'image-source',
          role: 'background',
          title: '屋顶',
          ...summaryOf(summaries.image),
          ...usage,
          layout
        },
        {
          kind: 'audio',
          cardId: 'audio-card',
          sourceId: 'audio-source',
          role: 'music',
          title: '夜色',
          ...summaryOf(summaries.audio),
          ...usage,
          layout: { ...layout, x: 20 }
        },
        {
          kind: 'video',
          cardId: 'video-card',
          sourceId: 'video-source',
          title: '开场',
          ...summaryOf(summaries.video),
          ...usage,
          layout: { ...layout, x: 40 }
        },
        {
          kind: 'prompt',
          cardId: 'prompt-card',
          ...(full ? { title: '提示词', summary: '' } : {}),
          body: '补充用途',
          references: [],
          ...usage,
          layout: { ...layout, x: 60 }
        }
      ],
      relations: []
    })
  )
}

async function writeFieldArrangement(
  root: string,
  formatVersion: number
): Promise<Record<string, unknown>> {
  const full =
    formatVersion === PROJECT_ARRANGEMENT_FORMAT_VERSION ||
    formatVersion === SCENE_CANVAS_ARRANGEMENT_FORMAT_VERSION
  const layout = (x: number): { x: number; y: number; width: number; height: number } => ({
    x,
    y: 0,
    width: 10,
    height: 10
  })
  const documentUsage = {
    characterId: 'char-1',
    locationId: 'loc-1',
    spokenLine: '设定台词',
    targetIds: ['image-card']
  }
  const imageUsage = { characterId: 'char-2', targetIds: ['document-card'] }
  const promptUsage = {
    locationId: 'loc-2',
    spokenLine: '提示词台词',
    targetIds: ['image-card']
  }
  const animationUsage = { targetIds: ['effect-card'] }
  const effectUsage = { targetIds: [] as string[] }
  const document: Record<string, unknown> = {
    formatVersion,
    projectId: 'project-1',
    sceneId: 'scene-1',
    canvasId: 'canvas-1',
    viewport: { x: 0, y: 0, zoom: 1 },
    cards: [
      {
        kind: 'document',
        cardId: 'document-card',
        sourceId: 'document-source',
        title: '设定标题',
        summary: '设定摘要',
        ...(full ? { usage: documentUsage } : {}),
        layout: layout(0)
      },
      {
        kind: 'image',
        cardId: 'image-card',
        sourceId: 'image-source',
        role: 'characterImage',
        title: '人物标题',
        summary: '人物摘要',
        ...(full ? { usage: imageUsage } : {}),
        layout: layout(20)
      },
      {
        kind: 'prompt',
        cardId: 'prompt-card',
        ...(full ? { title: '提示词标题', summary: '提示词摘要' } : {}),
        body: '提示词正文',
        references: [{ cardId: 'image-card' }],
        ...(full ? { usage: promptUsage } : {}),
        layout: layout(40)
      },
      {
        kind: 'animation',
        cardId: 'animation-card',
        ...(full ? { title: '动画标题', summary: '动画摘要' } : {}),
        webgalPreset: { command: 'setAnimation', name: '淡入' },
        ...(full ? { usage: animationUsage } : {}),
        layout: layout(60)
      },
      {
        kind: 'effect',
        cardId: 'effect-card',
        ...(full ? { title: '特效标题', summary: '' } : {}),
        webgalPreset: null,
        ...(full ? { usage: effectUsage } : {}),
        layout: layout(80)
      }
    ],
    relations: [
      {
        relationId: 'rel-prompt',
        fromCardId: 'prompt-card',
        toCardId: 'image-card',
        ...(full ? { defaultRelation: 'actsOn' } : {}),
        specificName: '挥手',
        recordCardId: null
      },
      {
        relationId: 'rel-document',
        fromCardId: 'document-card',
        toCardId: 'image-card',
        ...(full ? { defaultRelation: 'constrains' } : {}),
        specificName: '约束',
        recordCardId: 'document-card'
      }
    ]
  }
  await writeRelative(root, arrangementPath('scene-1', 'canvas-1'), JSON.stringify(document))
  return document
}

async function expectArrangementVersionTracksCanvasFile(
  root: string,
  document: Record<string, unknown>,
  version: string
): Promise<void> {
  const unchanged = await gateway(root).readInputs(source(root), selection())
  expect(unchanged.arrangementVersion).toBe(version)
  await writeRelative(
    root,
    arrangementPath('scene-1', 'canvas-1'),
    JSON.stringify({ ...document, viewport: { x: 5, y: 6, zoom: 1 } })
  )
  const changed = await gateway(root).readInputs(source(root), selection())
  expect(changed.arrangementVersion).not.toBe(version)
}

async function writeDocument(root: string, sourceId: string, body: string): Promise<void> {
  const key = encodeStorageKey(sourceId)
  await writeRelative(
    root,
    sourceDescriptorPath(sourceId),
    JSON.stringify({
      formatVersion: 1,
      projectId: 'project-1',
      sourceId,
      content: {
        kind: 'document',
        title: '设定',
        topics: ['角色'],
        importFormat: 'markdown',
        bodyFile: `${key}.md`
      }
    })
  )
  await writeRelative(root, documentBodyPath(sourceId, 'md'), body)
}

async function writeAsset(
  root: string,
  sourceId: string,
  fileType: 'image' | 'audio' | 'video',
  bytes: Buffer,
  fileName: string
): Promise<void> {
  await writeRelative(
    root,
    sourceDescriptorPath(sourceId),
    JSON.stringify({
      formatVersion: 1,
      projectId: 'project-1',
      sourceId,
      content: {
        kind: 'asset',
        name: fileName,
        fileType,
        description: '说明',
        fileId: `file-${sourceId}`,
        mediaPath: `assets/${fileName}`
      }
    })
  )
  await writeRelative(root, `assets/${fileName}`, bytes)
}

async function writeRelative(
  root: string,
  relativePath: string,
  content: string | Buffer
): Promise<void> {
  const target = join(root, relativePath)
  await mkdir(dirname(target), { recursive: true })
  await writeFile(target, content)
}
