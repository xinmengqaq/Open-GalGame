import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import type { SceneCanvasArrangementVO } from '@application/scene-canvas/vo/SceneCanvasArrangementVO'
import { AppException } from '@common/errors/AppException'
import { SceneCanvasErrorCodes } from '@domain/scene-canvas/errors/SceneCanvasErrorCodes'
import { LocalSceneCanvasArrangementPersistenceGatewayImpl } from '@infrastructure/scene-canvas/LocalSceneCanvasArrangementPersistenceGatewayImpl'
import { SCENE_CANVAS_ARRANGEMENT_FORMAT_VERSION } from '@infrastructure/scene-canvas/documents/SceneCanvasArrangementDocument'
import {
  arrangementPath,
  encodeStorageKey,
  MAX_IDENTITY_BYTES,
  MAX_JSON_BYTES
} from '@infrastructure/project-files/projectFilePaths'

const directories: string[] = []

afterEach(async () => {
  for (const directory of directories.splice(0)) {
    await rm(directory, { recursive: true, force: true })
  }
})

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'opengalgame-scene-canvas-'))
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
  return new LocalSceneCanvasArrangementPersistenceGatewayImpl(async (projectId) => ({
    projectId,
    directory: root
  }))
}

function arrangement(body = '提示词\n  保留'): SceneCanvasArrangementVO {
  return {
    projectId: 'project-1',
    sceneId: 'scene-1',
    canvasId: 'canvas-1',
    viewport: { x: 1, y: 2, zoom: 1 },
    cards: [
      {
        kind: 'prompt',
        cardId: 'prompt-1',
        body,
        references: [],
        layout: { x: 0, y: 0, width: 100, height: 80 }
      },
      {
        kind: 'document',
        cardId: 'doc-1',
        sourceId: 'source-1',
        title: '设定',
        summary: '',
        layout: { x: 10, y: 20, width: 120, height: 90 }
      }
    ],
    relations: [
      {
        relationId: 'rel-1',
        fromCardId: 'doc-1',
        toCardId: 'prompt-1',
        specificName: '',
        recordCardId: 'prompt-1'
      }
    ]
  }
}

describe('场景画布编排存储', () => {
  it('写入后重读一致，并用紧凑 JSON 保留正文', async () => {
    const root = await temporaryRoot()
    const store = gateway(root)
    await store.writeArrangement(arrangement())
    const text = await readFile(join(root, arrangementPath('scene-1', 'canvas-1')), 'utf8')
    expect(text).not.toContain('\n  ')
    expect(text).toContain('提示词\\n  保留')
    await expect(store.readArrangement('project-1', 'scene-1', 'canvas-1')).resolves.toEqual(
      arrangement()
    )
  })

  it('提示词卡缩放后的宽高随格式 4 往返', async () => {
    const root = await temporaryRoot()
    const store = gateway(root)
    const saved = arrangement()
    const prompt = saved.cards.find((card) => card.kind === 'prompt')
    if (!prompt) throw new Error('测试编排缺少提示词卡')
    prompt.layout = { x: 30, y: 40, width: 480, height: 360 }
    await store.writeArrangement(saved)
    const text = await readFile(join(root, arrangementPath('scene-1', 'canvas-1')), 'utf8')
    expect(JSON.parse(text)).toMatchObject({
      formatVersion: SCENE_CANVAS_ARRANGEMENT_FORMAT_VERSION
    })
    const reread = await store.readArrangement('project-1', 'scene-1', 'canvas-1')
    expect(reread?.cards.find((card) => card.kind === 'prompt')?.layout).toEqual({
      x: 30,
      y: 40,
      width: 480,
      height: 360
    })
  })

  it('超过原来源容量上限的合法编排可以往返', async () => {
    const root = await temporaryRoot()
    const store = gateway(root)
    const saved = arrangement('x'.repeat(MAX_JSON_BYTES + 1))
    await store.writeArrangement(saved)
    await expect(store.readArrangement('project-1', 'scene-1', 'canvas-1')).resolves.toEqual(saved)
  })

  it('拒绝写入读取格式不能接受的身份，并保留原文件', async () => {
    const root = await temporaryRoot()
    const store = gateway(root)
    const saved = arrangement()
    await store.writeArrangement(saved)
    const overlong = arrangement()
    overlong.cards = [
      { ...overlong.cards[0]!, cardId: 'a'.repeat(MAX_IDENTITY_BYTES + 1) },
      overlong.cards[1]!
    ]
    overlong.relations = []
    await expect(store.writeArrangement(overlong)).rejects.toMatchObject({
      code: SceneCanvasErrorCodes.persistFailed
    })
    await expect(store.readArrangement('project-1', 'scene-1', 'canvas-1')).resolves.toEqual(saved)
    const maxId = 'b'.repeat(MAX_IDENTITY_BYTES)
    const maxArrangement = arrangement()
    maxArrangement.cards = [
      { ...maxArrangement.cards[0]!, cardId: maxId },
      maxArrangement.cards[1]!
    ]
    maxArrangement.relations = []
    await store.writeArrangement(maxArrangement)
    await expect(store.readArrangement('project-1', 'scene-1', 'canvas-1')).resolves.toEqual(
      maxArrangement
    )
  })

  it('已保存编排违反领域规则时按内容损坏读取', async () => {
    const root = await temporaryRoot()
    const store = gateway(root)
    await store.writeArrangement(arrangement())
    const relative = arrangementPath('scene-1', 'canvas-1')
    const document = JSON.parse(await readFile(join(root, relative), 'utf8')) as {
      relations: { toCardId: string }[]
    }
    document.relations[0]!.toCardId = 'missing-card'
    await writeFile(join(root, relative), JSON.stringify(document), 'utf8')
    await expect(store.readArrangement('project-1', 'scene-1', 'canvas-1')).rejects.toMatchObject({
      code: SceneCanvasErrorCodes.contentDamaged
    })
  })

  it('区分缺失、损坏、旧格式和归属错误', async () => {
    const root = await temporaryRoot()
    const store = gateway(root)
    await expect(store.readArrangement('project-1', 'scene-1', 'canvas-1')).resolves.toBeNull()

    const relative = arrangementPath('scene-1', 'canvas-1')
    await writeRelative(root, relative, '{')
    await expect(store.readArrangement('project-1', 'scene-1', 'canvas-1')).rejects.toMatchObject({
      code: SceneCanvasErrorCodes.contentDamaged
    })

    await writeRelative(
      root,
      relative,
      JSON.stringify({
        formatVersion: SCENE_CANVAS_ARRANGEMENT_FORMAT_VERSION - 1,
        projectId: 'project-1',
        sceneId: 'scene-1',
        canvasId: 'canvas-1'
      })
    )
    await expect(store.readArrangement('project-1', 'scene-1', 'canvas-1')).rejects.toMatchObject({
      code: SceneCanvasErrorCodes.unsupportedFormat
    })

    await store.writeArrangement(arrangement())
    const owned = JSON.parse(await readFile(join(root, relative), 'utf8')) as {
      projectId: string
    }
    owned.projectId = 'other-project'
    await writeFile(join(root, relative), JSON.stringify(owned), 'utf8')
    await expect(store.readArrangement('project-1', 'scene-1', 'canvas-1')).rejects.toMatchObject({
      code: SceneCanvasErrorCodes.ownershipMismatch
    })
  })

  it('编排目录指向工程外时拒绝写入', async () => {
    const root = await temporaryRoot()
    const outside = await mkdtemp(join(tmpdir(), 'opengalgame-scene-canvas-outside-'))
    directories.push(outside)
    const link = join(root, '.opengalgame', 'canvases')
    try {
      await symlink(outside, link, 'junction')
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'EPERM') return
      throw error
    }
    await expect(gateway(root).writeArrangement(arrangement())).rejects.toBeInstanceOf(AppException)
    expect(
      await readFile(
        join(outside, encodeStorageKey('scene-1'), `${encodeStorageKey('canvas-1')}.json`),
        'utf8'
      ).catch(() => null)
    ).toBeNull()
  })

  it('旧提示词记录缺省引用为空，保存后重读保持引用身份', async () => {
    const root = await temporaryRoot()
    const store = gateway(root)
    const relative = arrangementPath('scene-1', 'canvas-1')
    const legacy = arrangement()
    const document = {
      formatVersion: SCENE_CANVAS_ARRANGEMENT_FORMAT_VERSION,
      projectId: legacy.projectId,
      sceneId: legacy.sceneId,
      canvasId: legacy.canvasId,
      viewport: legacy.viewport,
      cards: legacy.cards.map((card) => {
        if (card.kind !== 'prompt') return card
        const { references: _references, ...withoutReferences } = card
        return withoutReferences
      }),
      relations: legacy.relations
    }
    await writeRelative(root, relative, JSON.stringify(document))
    const read = await store.readArrangement('project-1', 'scene-1', 'canvas-1')
    expect(read?.cards.find((card) => card.kind === 'prompt')).toMatchObject({ references: [] })

    const renamed = structuredClone(legacy)
    const documentCard = renamed.cards.find((card) => card.cardId === 'doc-1')
    const promptCard = renamed.cards.find((card) => card.cardId === 'prompt-1')
    if (documentCard?.kind !== 'document' || promptCard?.kind !== 'prompt') {
      throw new Error('测试编排缺少文档卡或提示词卡')
    }
    documentCard.title = '新设定'
    promptCard.references = [{ cardId: 'doc-1' }]
    await store.writeArrangement(renamed)
    const saved = JSON.parse(await readFile(join(root, relative), 'utf8')) as {
      cards: { kind: string; references?: { cardId: string; displayName?: string }[] }[]
    }
    expect(saved.cards.find((card) => card.kind === 'prompt')?.references).toEqual([
      { cardId: 'doc-1' }
    ])
    const reread = await store.readArrangement('project-1', 'scene-1', 'canvas-1')
    expect(reread?.cards.find((card) => card.cardId === 'doc-1')).toMatchObject({ title: '新设定' })
    expect(reread?.cards.find((card) => card.cardId === 'prompt-1')).toMatchObject({
      references: [{ cardId: 'doc-1' }]
    })
  })

  it('图片和视频用途说明往返保留，旧记录缺字段读取为空并在写入时补上', async () => {
    const root = await temporaryRoot()
    const store = gateway(root)
    const relative = arrangementPath('scene-1', 'canvas-1')
    const media = arrangement()
    media.cards = [
      {
        kind: 'image',
        cardId: 'image-1',
        sourceId: 'source-image',
        role: 'characterImage',
        title: '人物',
        summary: '  人物立绘  ',
        layout: { x: 0, y: 0, width: 100, height: 80 }
      },
      {
        kind: 'video',
        cardId: 'video-1',
        sourceId: 'source-video',
        title: '开场',
        summary: '',
        layout: { x: 120, y: 0, width: 100, height: 80 }
      }
    ]
    media.relations = []
    await store.writeArrangement(media)
    const written = JSON.parse(await readFile(join(root, relative), 'utf8')) as {
      cards: { kind: string; summary?: string }[]
    }
    expect(written.cards.map((card) => [card.kind, card.summary])).toEqual([
      ['image', '  人物立绘  '],
      ['video', '']
    ])
    await expect(store.readArrangement('project-1', 'scene-1', 'canvas-1')).resolves.toEqual(media)

    const legacy = structuredClone(written)
    for (const card of legacy.cards) delete card.summary
    await writeRelative(root, relative, JSON.stringify(legacy))
    const read = await store.readArrangement('project-1', 'scene-1', 'canvas-1')
    expect(read?.cards.map((card) => ('summary' in card ? card.summary : 'missing'))).toEqual([
      '',
      ''
    ])
    await store.writeArrangement(read!)
    const restored = JSON.parse(await readFile(join(root, relative), 'utf8')) as {
      cards: { summary?: string }[]
    }
    expect(restored.cards.every((card) => card.summary === '')).toBe(true)
  })

  it('保存离画布或重复的提示词引用时明确失败', async () => {
    const root = await temporaryRoot()
    const store = gateway(root)
    const missing = arrangement()
    const prompt = missing.cards.find((card) => card.kind === 'prompt')
    if (prompt?.kind !== 'prompt') throw new Error('测试编排缺少提示词卡')
    prompt.references = [{ cardId: 'missing-card' }]
    await expect(store.writeArrangement(missing)).rejects.toMatchObject({
      code: SceneCanvasErrorCodes.targetMissing,
      message: '提示词引用必须是当前画布中的其他卡片'
    })

    const duplicated = arrangement()
    const duplicatedPrompt = duplicated.cards.find((card) => card.kind === 'prompt')
    if (duplicatedPrompt?.kind !== 'prompt') throw new Error('测试编排缺少提示词卡')
    duplicatedPrompt.references = [{ cardId: 'doc-1' }, { cardId: 'doc-1' }]
    await expect(store.writeArrangement(duplicated)).rejects.toMatchObject({
      code: SceneCanvasErrorCodes.identityConflict,
      message: '同一提示词不能重复引用同一卡片'
    })
  })
})
