import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { SceneInputGatewayImpl } from '@infrastructure/scene-generation/inputs/SceneInputGatewayImpl'
import { SCENE_CANVAS_ARRANGEMENT_FORMAT_VERSION } from '@infrastructure/scene-canvas/documents/SceneCanvasArrangementDocument'
import {
  arrangementPath,
  documentBodyPath,
  encodeStorageKey,
  PROJECT_ARRANGEMENT_FORMAT_VERSION,
  sourceDescriptorPath
} from '@infrastructure/project-files/projectFilePaths'

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
      message: '提示词引用的卡片不在当前画布或无法读取'
    })

    await writeArrangement(root, promptCard([{ cardId: 'image-card' }, { cardId: 'image-card' }]))
    await expect(gateway(root).readInputs(source(root), selection())).rejects.toMatchObject({
      message: '同一提示词不能重复引用同一卡片'
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
      message: '提示词引用的卡片不在当前画布或无法读取'
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
})

function gateway(root: string): SceneInputGatewayImpl {
  return new SceneInputGatewayImpl([{ source: source(root) }])
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
          layout: { x: 0, y: 0, width: 10, height: 10 }
        },
        {
          kind: 'image',
          cardId: 'image-card',
          sourceId: 'image-source',
          role: 'characterImage',
          title: titles.imageTitle ?? '人物',
          summary: '人物立绘',
          layout: { x: 20, y: 0, width: 10, height: 10 }
        },
        prompt,
        ...(extra === undefined ? [] : [extra])
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
  const usage =
    formatVersion === PROJECT_ARRANGEMENT_FORMAT_VERSION ? { usage: { targetIds: [] } } : {}
  const summaryOf = (value: string | undefined): { summary?: string } =>
    value === undefined ? {} : { summary: value }
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
          ...(formatVersion === PROJECT_ARRANGEMENT_FORMAT_VERSION
            ? { title: '提示词', summary: '' }
            : {}),
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
