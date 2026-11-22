import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import type { SceneCanvasVersionSettlement } from '@application/scene-canvas/models/SceneCanvasSaveFacts'
import type { SceneCanvasArrangementPersistenceGateway } from '@application/scene-canvas/ports/SceneCanvasArrangementPersistenceGateway'
import { EditSceneCanvas } from '@application/scene-canvas/services/impl/EditSceneCanvas'
import type { SceneCanvasArrangementVO } from '@application/scene-canvas/vo/SceneCanvasArrangementVO'
import { SceneCanvasErrorCodes } from '@common/errors/SceneCanvasErrorCodes'
import { LocalSceneCanvasArrangementPersistenceGatewayImpl } from '@infrastructure/scene-canvas/LocalSceneCanvasArrangementPersistenceGatewayImpl'
import { CanvasArrangementMigration } from '@infrastructure/scene-canvas/migration/CanvasArrangementMigration'
import { SCENE_CANVAS_ARRANGEMENT_FORMAT_VERSION } from '@infrastructure/scene-canvas/documents/SceneCanvasArrangementDocument'
import { PROJECT_ARRANGEMENT_FORMAT_VERSION } from '@infrastructure/scene-canvas/migration/legacy/documents/LegacySceneCanvasArrangementDocument'
import { sceneCanvasArrangementV4DocumentSchema } from '@infrastructure/scene-canvas/migration/legacy/documents/SceneCanvasArrangementV4Document'
import { v4DocumentToCurrent } from '@infrastructure/scene-canvas/migration/legacy/mapping/LegacySceneArrangementMapping'
import { arrangementPath } from '@infrastructure/scene-canvas/sceneCanvasPaths'

const directories: string[] = []

afterEach(async () => {
  for (const directory of directories.splice(0)) {
    await rm(directory, { recursive: true, force: true })
  }
})

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'opengalgame-canvas-field-snapshot-'))
  directories.push(root)
  await writeRelative(
    root,
    '.opengalgame/manifest.json',
    `${JSON.stringify({ formatVersion: 2, projectId: 'project-1', operationId: 'op-1' }, null, 2)}\n`
  )
  return root
}

async function writeRelative(root: string, relativePath: string, content: string): Promise<void> {
  const target = join(root, relativePath)
  await mkdir(dirname(target), { recursive: true })
  await writeFile(target, content, 'utf8')
}

function gateway(root: string): LocalSceneCanvasArrangementPersistenceGatewayImpl {
  const backupRoot = `${root}-migration`
  directories.push(backupRoot)
  return new LocalSceneCanvasArrangementPersistenceGatewayImpl(
    async (projectId) => ({
      projectId,
      directory: root
    }),
    new CanvasArrangementMigration({ backupRoot })
  )
}

function applicationService(
  root: string,
  persistence: SceneCanvasArrangementPersistenceGateway = gateway(root)
): EditSceneCanvas {
  return new EditSceneCanvas({
    sources: {
      readProjectInputSources: async () => {
        throw new Error('本用例不读取来源')
      }
    },
    persistence,
    versions: {
      keepArrangement: async (): Promise<SceneCanvasVersionSettlement> => ({ state: 'kept' }),
      readSettlement: async (): Promise<SceneCanvasVersionSettlement> => ({ state: 'kept' }),
      readArrangementVersion: async () => ({
        projectId: 'project-1',
        sceneId: 'scene-1',
        canvasId: 'canvas-1',
        arrangementVersion: 'unused'
      })
    },
    workspace: { inspectProjectWorkspace: async () => ({ ready: true }) },
    nextId: () => 'op-r11'
  })
}

function arrangement(): SceneCanvasArrangementVO {
  const layout = { x: 0, y: 0, width: 100, height: 80 }
  return {
    projectId: 'project-1',
    sceneId: 'scene-1',
    canvasId: 'canvas-1',
    viewport: { x: 1, y: 2, zoom: 1.5 },
    cards: [
      {
        kind: 'document',
        cardId: 'document-card',
        sourceId: 'document-source',
        title: '设定标题',
        summary: '设定摘要',
        layout
      },
      {
        kind: 'image',
        cardId: 'image-card',
        sourceId: 'image-source',
        role: 'characterImage',
        title: '人物标题',
        summary: '人物摘要',
        layout: { ...layout, x: 120 }
      },
      {
        kind: 'audio',
        cardId: 'audio-card',
        sourceId: 'audio-source',
        role: 'music',
        title: '夜色',
        summary: '夜间氛围',
        layout: { ...layout, x: 240 }
      },
      {
        kind: 'video',
        cardId: 'video-card',
        sourceId: 'video-source',
        title: '开场',
        summary: '开场镜头',
        layout: { ...layout, x: 360 }
      },
      {
        kind: 'prompt',
        cardId: 'prompt-card',
        body: '提示词正文',
        references: [{ cardId: 'image-card' }],
        layout: { ...layout, x: 480 }
      },
      {
        kind: 'animation',
        cardId: 'animation-card',
        webgalPreset: { command: 'setAnimation', name: '淡入' },
        layout: { ...layout, x: 600 }
      },
      {
        kind: 'effect',
        cardId: 'effect-card',
        webgalPreset: null,
        layout: { ...layout, x: 720 }
      }
    ],
    relations: [
      {
        relationId: 'rel-prompt',
        fromCardId: 'prompt-card',
        toCardId: 'image-card',
        specificName: '引用',
        recordCardId: null
      },
      {
        relationId: 'rel-document',
        fromCardId: 'document-card',
        toCardId: 'image-card',
        specificName: '使用',
        recordCardId: 'document-card'
      }
    ]
  }
}

function currentFieldDocument(): Record<string, unknown> {
  const layout = { x: 0, y: 0, width: 100, height: 80 }
  return {
    formatVersion: SCENE_CANVAS_ARRANGEMENT_FORMAT_VERSION,
    projectId: 'project-1',
    sceneId: 'scene-1',
    canvasId: 'canvas-1',
    viewport: { x: 1, y: 2, zoom: 1.5 },
    cards: [
      {
        kind: 'document',
        cardId: 'document-card',
        sourceId: 'document-source',
        title: '设定标题',
        summary: '设定摘要',
        usage: {
          characterId: 'char-1',
          locationId: 'loc-1',
          spokenLine: '设定台词',
          targetIds: ['image-card']
        },
        layout
      },
      {
        kind: 'prompt',
        cardId: 'prompt-card',
        title: '真实提示词标题',
        summary: '真实提示词摘要',
        body: '提示词正文',
        references: [{ cardId: 'document-card' }],
        usage: {
          locationId: 'loc-2',
          spokenLine: '提示词台词',
          targetIds: ['document-card']
        },
        layout: { ...layout, x: 120 }
      }
    ],
    relations: [
      {
        relationId: 'rel-1',
        fromCardId: 'prompt-card',
        toCardId: 'document-card',
        defaultRelation: 'actsOn',
        specificName: '引用',
        recordCardId: 'document-card'
      }
    ]
  }
}

describe('场景画布当前 schema 字段往返（R11）', () => {
  it('当前 v5 写入后读回一致，落盘包含真实字段快照；VO 之外的字段按身份默认补齐', async () => {
    const root = await temporaryRoot()
    const store = gateway(root)
    const saved = arrangement()
    await store.writeArrangement(saved, null)
    const reread = await store.readArrangement('project-1', 'scene-1', 'canvas-1')
    expect(reread?.arrangement).toEqual(saved)

    const raw = JSON.parse(
      await readFile(join(root, arrangementPath('scene-1', 'canvas-1')), 'utf8')
    ) as Record<string, unknown>
    expect(raw).toEqual({
      formatVersion: SCENE_CANVAS_ARRANGEMENT_FORMAT_VERSION,
      projectId: 'project-1',
      sceneId: 'scene-1',
      canvasId: 'canvas-1',
      viewport: { x: 1, y: 2, zoom: 1.5 },
      cards: [
        {
          kind: 'document',
          cardId: 'document-card',
          sourceId: 'document-source',
          title: '设定标题',
          summary: '设定摘要',
          usage: { targetIds: [] },
          layout: { x: 0, y: 0, width: 100, height: 80 }
        },
        {
          kind: 'image',
          cardId: 'image-card',
          sourceId: 'image-source',
          role: 'characterImage',
          title: '人物标题',
          summary: '人物摘要',
          usage: { targetIds: [] },
          layout: { x: 120, y: 0, width: 100, height: 80 }
        },
        {
          kind: 'audio',
          cardId: 'audio-card',
          sourceId: 'audio-source',
          role: 'music',
          title: '夜色',
          summary: '夜间氛围',
          usage: { targetIds: [] },
          layout: { x: 240, y: 0, width: 100, height: 80 }
        },
        {
          kind: 'video',
          cardId: 'video-card',
          sourceId: 'video-source',
          title: '开场',
          summary: '开场镜头',
          usage: { targetIds: [] },
          layout: { x: 360, y: 0, width: 100, height: 80 }
        },
        {
          kind: 'prompt',
          cardId: 'prompt-card',
          title: 'prompt-card',
          summary: '',
          body: '提示词正文',
          references: [{ cardId: 'image-card' }],
          usage: { targetIds: [] },
          layout: { x: 480, y: 0, width: 100, height: 80 }
        },
        {
          kind: 'animation',
          cardId: 'animation-card',
          title: 'animation-card',
          summary: '',
          webgalPreset: { command: 'setAnimation', name: '淡入' },
          usage: { targetIds: [] },
          layout: { x: 600, y: 0, width: 100, height: 80 }
        },
        {
          kind: 'effect',
          cardId: 'effect-card',
          title: 'effect-card',
          summary: '',
          webgalPreset: null,
          usage: { targetIds: [] },
          layout: { x: 720, y: 0, width: 100, height: 80 }
        }
      ],
      relations: [
        {
          relationId: 'rel-prompt',
          fromCardId: 'prompt-card',
          toCardId: 'image-card',
          defaultRelation: 'associated',
          specificName: '引用',
          recordCardId: null
        },
        {
          relationId: 'rel-document',
          fromCardId: 'document-card',
          toCardId: 'image-card',
          defaultRelation: 'associated',
          specificName: '使用',
          recordCardId: 'document-card'
        }
      ]
    })
  })

  it('旧 v4 字面量 4 文档仍可读取，缺失业务字段只作为读取默认值补齐', async () => {
    const root = await temporaryRoot()
    const store = gateway(root)
    const saved = arrangement()
    await writeRelative(
      root,
      arrangementPath('scene-1', 'canvas-1'),
      JSON.stringify({ formatVersion: 4, ...saved })
    )
    const reread = await store.readArrangement('project-1', 'scene-1', 'canvas-1')
    expect(reread?.arrangement).toEqual(saved)
  })

  it('旧 v4 文件含 v5 业务字段时迁移工具判损坏，产品按旧格式不支持拒绝', async () => {
    const root = await temporaryRoot()
    const store = gateway(root)
    const relativePath = arrangementPath('scene-1', 'canvas-1')
    const valid: Record<string, unknown> = { formatVersion: 4, ...arrangement() }
    await writeRelative(root, relativePath, JSON.stringify(valid))
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

    const withUsage = structuredClone(valid)
    cardOfKind(withUsage, 'prompt').usage = { targetIds: [] }
    await writeFile(join(root, relativePath), JSON.stringify(withUsage), 'utf8')
    await expect(store.readArrangement('project-1', 'scene-1', 'canvas-1')).rejects.toMatchObject({
      code: SceneCanvasErrorCodes.unsupportedFormat
    })

    const withDefaultRelation = structuredClone(valid)
    const relations = withDefaultRelation.relations
    if (!Array.isArray(relations) || relations[0] === null || typeof relations[0] !== 'object') {
      throw new Error('测试画布缺少关联')
    }
    ;(relations[0] as Record<string, unknown>).defaultRelation = 'actsOn'
    await writeFile(join(root, relativePath), JSON.stringify(withDefaultRelation), 'utf8')
    await expect(store.readArrangement('project-1', 'scene-1', 'canvas-1')).rejects.toMatchObject({
      code: SceneCanvasErrorCodes.unsupportedFormat
    })

    const withPromptTitle = structuredClone(valid)
    cardOfKind(withPromptTitle, 'prompt').title = '提示词标题'
    await writeFile(join(root, relativePath), JSON.stringify(withPromptTitle), 'utf8')
    await expect(store.readArrangement('project-1', 'scene-1', 'canvas-1')).rejects.toMatchObject({
      code: SceneCanvasErrorCodes.unsupportedFormat
    })
    expect(JSON.parse(await readFile(join(root, relativePath), 'utf8'))).toEqual(withPromptTitle)
  })

  it('旧格式迁移失败时正常保存先读取并拒绝，不覆盖源文件', async () => {
    const root = await temporaryRoot()
    const relativePath = arrangementPath('scene-1', 'canvas-1')
    const invalidLegacy = structuredClone(arrangement()) as unknown as Record<string, unknown>
    invalidLegacy.formatVersion = 4
    const cards = invalidLegacy.cards as Record<string, unknown>[]
    const prompt = cards.find((card) => card.kind === 'prompt')
    if (prompt === undefined) throw new Error('测试编排缺少提示词卡')
    prompt.title = '旧格式不应保存的业务字段'
    await writeRelative(root, relativePath, JSON.stringify(invalidLegacy))
    const before = await readFile(join(root, relativePath))
    const service = applicationService(root)
    await expect(
      service.saveSceneCanvasArrangement({
        projectId: 'project-1',
        sceneId: 'scene-1',
        canvasId: 'canvas-1',
        reason: 'manual',
        arrangement: arrangement()
      })
    ).rejects.toMatchObject({ code: SceneCanvasErrorCodes.unsupportedFormat })
    expect(await readFile(join(root, relativePath))).toEqual(before)
  })

  it('旧 v4 转当前模型的缺失字段逐项记录为 defaulted，不冒充旧保存事实', () => {
    const v4 = sceneCanvasArrangementV4DocumentSchema.parse({
      formatVersion: 4,
      ...arrangement()
    })
    const { arrangement: current, defaulted } = v4DocumentToCurrent(v4)
    expect(current.cards.find((card) => card.cardId === 'document-card')).toMatchObject({
      title: '设定标题',
      summary: '设定摘要'
    })
    expect(current.cards.find((card) => card.cardId === 'prompt-card')).toMatchObject({
      title: 'prompt-card',
      summary: '',
      references: [{ cardId: 'image-card' }],
      usage: { targetIds: [] }
    })
    expect(current.relations.map((relation) => relation.defaultRelation)).toEqual([
      'associated',
      'associated'
    ])
    expect(defaulted).toEqual([
      { object: 'card', objectId: 'document-card', field: 'usage' },
      { object: 'card', objectId: 'image-card', field: 'usage' },
      { object: 'card', objectId: 'audio-card', field: 'usage' },
      { object: 'card', objectId: 'video-card', field: 'usage' },
      { object: 'card', objectId: 'prompt-card', field: 'title' },
      { object: 'card', objectId: 'prompt-card', field: 'summary' },
      { object: 'card', objectId: 'prompt-card', field: 'usage' },
      { object: 'card', objectId: 'animation-card', field: 'title' },
      { object: 'card', objectId: 'animation-card', field: 'summary' },
      { object: 'card', objectId: 'animation-card', field: 'usage' },
      { object: 'card', objectId: 'effect-card', field: 'title' },
      { object: 'card', objectId: 'effect-card', field: 'summary' },
      { object: 'card', objectId: 'effect-card', field: 'usage' },
      { object: 'relation', objectId: 'rel-prompt', field: 'defaultRelation' },
      { object: 'relation', objectId: 'rel-document', field: 'defaultRelation' }
    ])
  })

  it('旧 v3 文件经当前画布持久化入口迁移为当前格式并保留真实字段', async () => {
    const root = await temporaryRoot()
    const store = gateway(root)
    const legacy = {
      formatVersion: PROJECT_ARRANGEMENT_FORMAT_VERSION,
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
          usage: { targetIds: [] },
          layout: { x: 0, y: 0, width: 100, height: 80 }
        }
      ],
      relations: []
    }
    await writeRelative(root, arrangementPath('scene-1', 'canvas-1'), JSON.stringify(legacy))
    const read = await store.readArrangement('project-1', 'scene-1', 'canvas-1')
    expect(read?.arrangement).toMatchObject({
      projectId: 'project-1',
      sceneId: 'scene-1',
      canvasId: 'canvas-1',
      cards: [
        {
          kind: 'document',
          cardId: 'document-card',
          sourceId: 'document-source',
          title: '设定标题',
          summary: '设定摘要'
        }
      ]
    })
    const migrated = JSON.parse(
      await readFile(join(root, arrangementPath('scene-1', 'canvas-1')), 'utf8')
    ) as { formatVersion: number; cards: { usage?: unknown }[] }
    expect(migrated.formatVersion).toBe(SCENE_CANVAS_ARRANGEMENT_FORMAT_VERSION)
    expect(migrated.cards[0]?.usage).toEqual({ targetIds: [] })
    const reread = await store.readArrangement('project-1', 'scene-1', 'canvas-1')
    expect(reread?.arrangement).toEqual(read?.arrangement)
  })

  it('真实当前 v5 文档经读取和应用层保存后，usage/defaultRelation 与提示词真实字段不丢', async () => {
    const root = await temporaryRoot()
    await writeRelative(
      root,
      arrangementPath('scene-1', 'canvas-1'),
      JSON.stringify(currentFieldDocument())
    )
    const service = applicationService(root)
    const read = await service.readSceneCanvasArrangement({
      projectId: 'project-1',
      sceneId: 'scene-1',
      canvasId: 'canvas-1'
    })
    expect(read).toEqual({
      projectId: 'project-1',
      sceneId: 'scene-1',
      canvasId: 'canvas-1',
      viewport: { x: 1, y: 2, zoom: 1.5 },
      cards: [
        {
          kind: 'document',
          cardId: 'document-card',
          sourceId: 'document-source',
          title: '设定标题',
          summary: '设定摘要',
          layout: { x: 0, y: 0, width: 100, height: 80 }
        },
        {
          kind: 'prompt',
          cardId: 'prompt-card',
          body: '提示词正文',
          references: [{ cardId: 'document-card' }],
          layout: { x: 120, y: 0, width: 100, height: 80 }
        }
      ],
      relations: [
        {
          relationId: 'rel-1',
          fromCardId: 'prompt-card',
          toCardId: 'document-card',
          specificName: '引用',
          recordCardId: 'document-card'
        }
      ]
    })
    const changed = structuredClone(read)
    if (changed === null) throw new Error('测试画布应已保存')
    changed.viewport = { x: 9, y: 8, zoom: 2 }
    const documentCard = changed.cards.find((card) => card.cardId === 'document-card')
    if (documentCard === undefined) throw new Error('测试画布缺少文档卡')
    documentCard.layout = { x: 5, y: 6, width: 120, height: 90 }
    await service.saveSceneCanvasArrangement({
      projectId: 'project-1',
      sceneId: 'scene-1',
      canvasId: 'canvas-1',
      reason: 'manual',
      arrangement: changed
    })

    const saved = JSON.parse(
      await readFile(join(root, arrangementPath('scene-1', 'canvas-1')), 'utf8')
    ) as {
      formatVersion: number
      viewport: Record<string, number>
      cards: Record<string, unknown>[]
      relations: Record<string, unknown>[]
    }
    expect(saved.formatVersion).toBe(SCENE_CANVAS_ARRANGEMENT_FORMAT_VERSION)
    expect(saved.viewport).toEqual({ x: 9, y: 8, zoom: 2 })
    expect(saved.cards).toEqual([
      {
        kind: 'document',
        cardId: 'document-card',
        sourceId: 'document-source',
        title: '设定标题',
        summary: '设定摘要',
        usage: {
          characterId: 'char-1',
          locationId: 'loc-1',
          spokenLine: '设定台词',
          targetIds: ['image-card']
        },
        layout: { x: 5, y: 6, width: 120, height: 90 }
      },
      {
        kind: 'prompt',
        cardId: 'prompt-card',
        title: '真实提示词标题',
        summary: '真实提示词摘要',
        body: '提示词正文',
        references: [{ cardId: 'document-card' }],
        usage: {
          locationId: 'loc-2',
          spokenLine: '提示词台词',
          targetIds: ['document-card']
        },
        layout: { x: 120, y: 0, width: 100, height: 80 }
      }
    ])
    expect(saved.relations).toEqual([
      {
        relationId: 'rel-1',
        fromCardId: 'prompt-card',
        toCardId: 'document-card',
        defaultRelation: 'actsOn',
        specificName: '引用',
        recordCardId: 'document-card'
      }
    ])
  })

  it('应用保存只使用同一次读取的快照，读取与写入之间的文件变化不丢真实字段也不触发第二次读取', async () => {
    const root = await temporaryRoot()
    const relativePath = arrangementPath('scene-1', 'canvas-1')
    await writeRelative(root, relativePath, JSON.stringify(currentFieldDocument()))
    const store = gateway(root)
    let mutateBeforeWrite = false
    let mutated = false
    const persistence: SceneCanvasArrangementPersistenceGateway = {
      readArrangement: async (projectId, sceneId, canvasId) => {
        const snapshot = await store.readArrangement(projectId, sceneId, canvasId)
        if (mutateBeforeWrite && !mutated) {
          mutated = true
          await writeRelative(
            root,
            relativePath,
            JSON.stringify({
              formatVersion: PROJECT_ARRANGEMENT_FORMAT_VERSION,
              projectId: 'project-1',
              sceneId: 'scene-1',
              canvasId: 'canvas-1',
              viewport: { x: 0, y: 0, zoom: 1 },
              cards: [],
              relations: []
            })
          )
        }
        return snapshot
      },
      writeArrangement: (arrangement, base) => store.writeArrangement(arrangement, base)
    }
    const service = applicationService(root, persistence)
    const read = await service.readSceneCanvasArrangement({
      projectId: 'project-1',
      sceneId: 'scene-1',
      canvasId: 'canvas-1'
    })
    if (read === null) throw new Error('测试画布应已保存')
    mutateBeforeWrite = true
    const changed = structuredClone(read)
    changed.viewport = { x: 9, y: 8, zoom: 2 }
    await service.saveSceneCanvasArrangement({
      projectId: 'project-1',
      sceneId: 'scene-1',
      canvasId: 'canvas-1',
      reason: 'manual',
      arrangement: changed
    })
    const saved = JSON.parse(await readFile(join(root, relativePath), 'utf8')) as {
      formatVersion: number
      viewport: Record<string, number>
      cards: Record<string, unknown>[]
      relations: Record<string, unknown>[]
    }
    expect(saved.formatVersion).toBe(SCENE_CANVAS_ARRANGEMENT_FORMAT_VERSION)
    expect(saved.viewport).toEqual({ x: 9, y: 8, zoom: 2 })
    expect(saved.cards.find((card) => card.cardId === 'document-card')).toMatchObject({
      title: '设定标题',
      summary: '设定摘要',
      usage: {
        characterId: 'char-1',
        locationId: 'loc-1',
        spokenLine: '设定台词',
        targetIds: ['image-card']
      }
    })
    expect(saved.cards.find((card) => card.cardId === 'prompt-card')).toMatchObject({
      title: '真实提示词标题',
      summary: '真实提示词摘要',
      usage: {
        locationId: 'loc-2',
        spokenLine: '提示词台词',
        targetIds: ['document-card']
      }
    })
    expect(saved.relations).toEqual([
      {
        relationId: 'rel-1',
        fromCardId: 'prompt-card',
        toCardId: 'document-card',
        defaultRelation: 'actsOn',
        specificName: '引用',
        recordCardId: 'document-card'
      }
    ])
  })
})
