import * as fs from 'node:fs/promises'
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { ProjectFilesApplicationServiceImpl } from '@application/project-files/services/impl/ProjectFilesApplicationServiceImpl'
import type { ProjectListQueryGateway } from '@application/projects/ports/ProjectListQueryGateway'
import { AppException } from '@common/errors/AppException'
import { ProjectFileErrorCodes } from '@domain/project-files/errors/ProjectFileErrorCodes'
import { ProjectDomainServiceImpl } from '@domain/projects/services/impl/ProjectDomainServiceImpl'
import { LocalProjectFileOperationGatewayImpl } from '@infrastructure/project-files/LocalProjectFileOperationGatewayImpl'
import { LocalProjectInputSourceReaderGatewayImpl } from '@infrastructure/project-files/LocalProjectInputSourceReaderGatewayImpl'
import { LocalSceneCanvasArrangementInspectionGatewayImpl } from '@infrastructure/scene-canvas/LocalSceneCanvasArrangementInspectionGatewayImpl'
import {
  encodeStorageKey,
  MAX_IDENTITY_BYTES,
  MAX_JSON_BYTES,
  MAX_MEDIA_BYTES
} from '@infrastructure/project-files/projectFilePaths'
import { LocalProjectStorageGatewayImpl } from '@infrastructure/projects/LocalProjectStorageGatewayImpl'

vi.mock('node:fs/promises', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:fs/promises')>())
}))

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
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>', 'utf8')

const directories: string[] = []

afterEach(async () => {
  vi.restoreAllMocks()
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true })
})

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'opengalgame-project-files-'))
  directories.push(root)
  return root
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

async function seedProject(root: string): Promise<void> {
  await writeRelative(
    root,
    '.opengalgame/manifest.json',
    `${JSON.stringify({ formatVersion: 2, projectId: 'project-1', operationId: 'op-1' }, null, 2)}\n`
  )
  await writeRelative(
    root,
    '.opengalgame/project.json',
    `${JSON.stringify({ id: 'project-1', name: '作品', synopsis: '' }, null, 2)}\n`
  )
}

function sourceKey(sourceId: string): string {
  return encodeStorageKey(sourceId)
}

function createService(root: string): ProjectFilesApplicationServiceImpl {
  const listQuery: ProjectListQueryGateway = {
    listRegistrations: async () => [],
    countRegistrations: async () => 0,
    findRegistration: async (id) =>
      id === 'project-1' ? { id: 'project-1', directory: root } : null
  }
  return new ProjectFilesApplicationServiceImpl({
    listQuery,
    domain: new ProjectDomainServiceImpl(),
    storage: new LocalProjectStorageGatewayImpl(),
    sources: new LocalProjectInputSourceReaderGatewayImpl(),
    arrangements: new LocalSceneCanvasArrangementInspectionGatewayImpl(),
    files: new LocalProjectFileOperationGatewayImpl(),
    versions: { readOperation: async () => 'unsettled', publish: async () => undefined },
    desktopOpen: { open: async () => undefined },
    createSourceId: () => 'unused-source',
    createOperationId: () => 'unused-operation'
  })
}

async function writeDocument(root: string, sourceId: string, body = '正文内容'): Promise<void> {
  const key = sourceKey(sourceId)
  await writeRelative(
    root,
    `.opengalgame/inputs/sources/${key}.json`,
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
  await writeRelative(root, `.opengalgame/inputs/documents/${key}.md`, body)
}

async function writePrompt(root: string, sourceId: string, body = '保持短句'): Promise<void> {
  const key = sourceKey(sourceId)
  await writeRelative(
    root,
    `.opengalgame/inputs/sources/${key}.json`,
    JSON.stringify({
      formatVersion: 1,
      projectId: 'project-1',
      sourceId,
      content: { kind: 'prompt', name: '语气', bodyFile: `${key}.txt` }
    })
  )
  await writeRelative(root, `.opengalgame/inputs/prompts/${key}.txt`, body)
}

async function writeAsset(
  root: string,
  sourceId: string,
  fileType: 'image' | 'audio' | 'video',
  bytes: Buffer,
  fileName: string
): Promise<void> {
  const key = sourceKey(sourceId)
  const mediaPath = `assets/${fileName}`
  await writeRelative(
    root,
    `.opengalgame/inputs/sources/${key}.json`,
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
        mediaPath
      }
    })
  )
  await writeRelative(root, mediaPath, bytes)
}

async function writePreset(
  root: string,
  sourceId: string,
  kind: 'animation' | 'effect'
): Promise<void> {
  const key = sourceKey(sourceId)
  await writeRelative(
    root,
    `.opengalgame/inputs/sources/${key}.json`,
    JSON.stringify({
      formatVersion: 1,
      projectId: 'project-1',
      sourceId,
      content: { kind, name: kind === 'animation' ? '淡入' : '冲击', contentFile: `${key}.json` }
    })
  )
  await writeRelative(
    root,
    `.opengalgame/inputs/presets/${key}.json`,
    JSON.stringify({
      formatVersion: 1,
      targets: [kind === 'animation' ? 'fig-center' : 'bg-main'],
      definition:
        kind === 'animation'
          ? {
              form: 'sequence',
              slices: [{ duration: 0, alpha: 0, bevelSoftness: 0.2, shockwaveFilter: 1 }]
            }
          : { form: 'transition', enter: 'shockwaveIn' },
      parameters: kind === 'effect' ? { ease: 'linear', duration: 300 } : {}
    })
  )
}

async function writeArrangement(
  root: string,
  cards: readonly (
    | { cardId: string; sourceId: string }
    | {
        cardId: string
        kind: 'animation' | 'effect'
        webgalPreset: { command: string; name: string } | null
      }
  )[],
  ids = { sceneId: 'scene-1', canvasId: 'canvas-1' }
): Promise<void> {
  await writeRelative(
    root,
    `.opengalgame/canvases/${sourceKey(ids.sceneId)}/${sourceKey(ids.canvasId)}.json`,
    JSON.stringify({
      formatVersion: 4,
      projectId: 'project-1',
      sceneId: ids.sceneId,
      canvasId: ids.canvasId,
      viewport: { x: 0, y: 0, zoom: 1 },
      relations: [],
      cards: cards.map((card, index) => {
        const layout = { x: index, y: index, width: 10, height: 12 }
        if ('kind' in card) {
          return {
            cardId: card.cardId,
            kind: card.kind,
            webgalPreset: card.webgalPreset,
            layout
          }
        }
        return {
          cardId: card.cardId,
          kind: 'document',
          sourceId: card.sourceId,
          title: '设定',
          summary: '',
          layout
        }
      })
    })
  )
}

describe('工程文件读取适配', () => {
  it('扫描并读取文档和文件素材；提示词文件不再作为来源', async () => {
    const root = await temporaryRoot()
    await seedProject(root)
    await writeDocument(root, 'doc-1')
    await writePrompt(root, 'prompt-1')
    await writeAsset(root, 'picture', 'image', PNG, 'bg.png')
    await writeAsset(root, 'portrait', 'image', SVG, 'avatar.svg')
    await writeAsset(root, 'music', 'audio', WAV, 'music.wav')
    await writeAsset(root, 'video', 'video', PNG, 'video.mp4')
    const service = createService(root)
    const listed = await service.listProjectInputSources({ projectId: 'project-1' })
    expect(listed.sources.find((item) => item.sourceId === 'doc-1')).toMatchObject({
      contentKind: 'text',
      textKind: 'document',
      readable: true
    })
    expect(listed.sources.some((item) => item.sourceId === 'prompt-1')).toBe(false)
    expect(listed.sources.find((item) => item.sourceId === 'video')?.readable).toBe(false)
    const snapshot = await service.readProjectInputSources({
      projectId: 'project-1',
      sourceIds: ['doc-1', 'picture']
    })
    expect(snapshot.sources.find((item) => item.sourceId === 'doc-1')).toMatchObject({
      importInfo: { format: 'markdown' },
      body: '正文内容'
    })
    expect(snapshot.sources.find((item) => item.sourceId === 'picture')).toMatchObject({
      contentKind: 'image',
      fileId: 'file-picture'
    })
    expect(JSON.stringify(snapshot)).not.toContain(root)
  })

  it('描述损坏、重复身份、格式版本不支持和用途不匹配可区分', async () => {
    const root = await temporaryRoot()
    await seedProject(root)
    await writeDocument(root, 'doc-1')
    await writeRelative(root, `.opengalgame/inputs/sources/${sourceKey('broken')}.json`, '{broken')
    const duplicateKey = sourceKey('dup-file')
    await writeRelative(
      root,
      `.opengalgame/inputs/sources/${duplicateKey}.json`,
      JSON.stringify({
        formatVersion: 1,
        projectId: 'project-1',
        sourceId: 'doc-1',
        content: {
          kind: 'document',
          title: '另一份',
          topics: [],
          importFormat: 'markdown',
          bodyFile: `${duplicateKey}.md`
        }
      })
    )
    await writeRelative(
      root,
      `.opengalgame/inputs/sources/${sourceKey('old')}.json`,
      JSON.stringify({
        formatVersion: 2,
        projectId: 'project-1',
        sourceId: 'old',
        content: { kind: 'prompt', name: '旧', bodyFile: `${sourceKey('old')}.txt` }
      })
    )
    await writeAsset(root, 'mismatch', 'image', WAV, 'fake.png')
    const service = createService(root)
    const inspection = await service.inspectProjectFiles({ projectId: 'project-1' })
    expect(inspection.inputSourceFormatSupported).toBe(false)
    expect(inspection.diagnostics).toEqual(
      expect.arrayContaining([
        { objectId: 'broken', kind: 'damaged' },
        { objectId: 'doc-1', kind: 'duplicateIdentity' },
        { objectId: 'mismatch', kind: 'damaged' }
      ])
    )
    await expect(
      service.readProjectInputSources({ projectId: 'project-1', sourceIds: ['old'] })
    ).rejects.toMatchObject({ code: ProjectFileErrorCodes.unsupportedFormat })
    await expect(
      service.readProjectInputSources({ projectId: 'project-1', sourceIds: ['mismatch'] })
    ).rejects.toMatchObject({ code: ProjectFileErrorCodes.contentDamaged })
    await expect(
      service.listProjectInputSources({ projectId: 'project-1' })
    ).rejects.toBeInstanceOf(AppException)
  })

  it('绝对路径、上级跳转和越界素材位置被拒绝', async () => {
    const root = await temporaryRoot()
    await seedProject(root)
    const key = sourceKey('escape')
    await writeRelative(
      root,
      `.opengalgame/inputs/sources/${key}.json`,
      JSON.stringify({
        formatVersion: 1,
        projectId: 'project-1',
        sourceId: 'escape',
        content: {
          kind: 'asset',
          name: '越界',
          fileType: 'image',
          description: '',
          fileId: 'file-escape',
          mediaPath: '../secret.png'
        }
      })
    )
    const service = createService(root)
    await expect(
      service.readProjectInputSources({ projectId: 'project-1', sourceIds: ['escape'] })
    ).rejects.toMatchObject({ code: ProjectFileErrorCodes.contentDamaged })
  })

  it('同尺寸替换改变版本，顺序不影响读取版本，未选中正文变化不影响选中来源', async () => {
    const root = await temporaryRoot()
    await seedProject(root)
    await writeDocument(root, 'doc-1', 'AAAA')
    await writeDocument(root, 'doc-2', 'BBBB')
    const service = createService(root)
    const first = await service.readProjectInputSources({
      projectId: 'project-1',
      sourceIds: ['doc-2', 'doc-1']
    })
    const reordered = await service.readProjectInputSources({
      projectId: 'project-1',
      sourceIds: ['doc-1', 'doc-2']
    })
    expect(reordered.readVersion).toBe(first.readVersion)
    await writeDocument(root, 'doc-2', 'CCCC')
    const selected = await service.readProjectInputSources({
      projectId: 'project-1',
      sourceIds: ['doc-1']
    })
    expect(selected.sources[0]?.version).toBe(
      first.sources.find((item) => item.sourceId === 'doc-1')?.version
    )
    await writeDocument(root, 'doc-1', 'ZZZZ')
    const replaced = await service.readProjectInputSources({
      projectId: 'project-1',
      sourceIds: ['doc-1']
    })
    expect(replaced.sources[0]?.version).not.toBe(selected.sources[0]?.version)
  })

  it('读取期间描述变化和身份文件变化明确失败', async () => {
    const root = await temporaryRoot()
    await seedProject(root)
    await writeDocument(root, 'doc-1')
    const service = createService(root)
    const actualRead = fs.readFile
    let changed = false
    vi.spyOn(fs, 'readFile').mockImplementation(async (...args: Parameters<typeof fs.readFile>) => {
      const bytes = await actualRead(...args)
      const path = String(args[0])
      if (!changed && path.includes('inputs') && path.endsWith('.json')) {
        changed = true
        await writeDocument(root, 'doc-1', '读取中修改')
      }
      return bytes
    })
    await expect(
      service.readProjectInputSources({ projectId: 'project-1', sourceIds: ['doc-1'] })
    ).rejects.toMatchObject({ code: ProjectFileErrorCodes.readChanged })
  })

  it('来源目录中的悬空链接使扫描失败，不把已有来源藏成空目录', async () => {
    const root = await temporaryRoot()
    await seedProject(root)
    await writeDocument(root, 'doc-1')
    const dangling = join(root, '.opengalgame', 'inputs', 'sources', `${sourceKey('ghost')}.json`)
    try {
      await symlink(join(root, 'missing-source.json'), dangling)
    } catch {
      await symlink(join(root, 'missing-source.json'), dangling, 'file')
    }
    const service = createService(root)
    await expect(service.listProjectInputSources({ projectId: 'project-1' })).rejects.toMatchObject(
      {
        code: ProjectFileErrorCodes.readFailed
      }
    )
    await expect(service.inspectProjectFiles({ projectId: 'project-1' })).rejects.toMatchObject({
      code: ProjectFileErrorCodes.readFailed
    })
  })

  it('可识别的重复来源身份保留为不可读取摘要，不让整次扫描失败', async () => {
    const root = await temporaryRoot()
    await seedProject(root)
    await writeDocument(root, 'doc')
    const otherKey = sourceKey('other')
    await writeRelative(
      root,
      `.opengalgame/inputs/sources/${otherKey}.json`,
      JSON.stringify({
        formatVersion: 1,
        projectId: 'project-1',
        sourceId: 'doc',
        content: {
          kind: 'document',
          title: '另一份',
          topics: [],
          importFormat: 'markdown',
          bodyFile: `${sourceKey('doc')}.md`
        }
      })
    )
    const service = createService(root)
    const listed = await service.listProjectInputSources({ projectId: 'project-1' })
    expect(listed.sources.filter((item) => item.sourceId === 'doc')).toEqual([
      expect.objectContaining({ sourceId: 'doc', readable: false }),
      expect.objectContaining({ sourceId: 'doc', readable: false })
    ])
    const inspection = await service.inspectProjectFiles({ projectId: 'project-1' })
    expect(inspection.diagnostics).toEqual(
      expect.arrayContaining([
        { objectId: 'doc', kind: 'damaged' },
        { objectId: 'doc', kind: 'duplicateIdentity' }
      ])
    )
  })

  it('遗留动画特效来源描述不再作为输入来源读取', async () => {
    const root = await temporaryRoot()
    await seedProject(root)
    await writeDocument(root, 'doc-1')
    await writePreset(root, 'effect-1', 'effect')
    const service = createService(root)
    const listed = await service.listProjectInputSources({ projectId: 'project-1' })
    expect(listed.sources.map((item) => item.sourceId)).toEqual(['doc-1'])
    const inspection = await service.inspectProjectFiles({ projectId: 'project-1' })
    expect(inspection.inputSourceFormatSupported).toBe(false)
    await expect(
      service.readProjectInputSources({ projectId: 'project-1', sourceIds: ['effect-1'] })
    ).rejects.toMatchObject({ code: ProjectFileErrorCodes.unsupportedFormat })
  })

  it('完整大 SVG 可扫描可读取', async () => {
    const root = await temporaryRoot()
    await seedProject(root)
    const largeSvg = Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg"><!--${'x'.repeat(200_010)}--></svg>`,
      'utf8'
    )
    await writeAsset(root, 'avatar', 'image', largeSvg, 'large.svg')
    const service = createService(root)
    const listed = await service.listProjectInputSources({ projectId: 'project-1' })
    expect(listed.sources.find((item) => item.sourceId === 'avatar')).toMatchObject({
      readable: true
    })
    await expect(
      service.readProjectInputSources({ projectId: 'project-1', sourceIds: ['avatar'] })
    ).resolves.toMatchObject({ sources: [{ sourceId: 'avatar', fileId: 'file-avatar' }] })
  })

  it('身份长度按带 .json 的文件名组件限制，201 字标题仍可读取', async () => {
    expect(() => encodeStorageKey('a'.repeat(MAX_IDENTITY_BYTES + 1))).toThrow(AppException)
    expect(encodeStorageKey('a'.repeat(MAX_IDENTITY_BYTES)).length).toBe(MAX_IDENTITY_BYTES * 2)
    const root = await temporaryRoot()
    await seedProject(root)
    const title = '标'.repeat(201)
    const key = sourceKey('doc-1')
    await writeRelative(
      root,
      `.opengalgame/inputs/sources/${key}.json`,
      JSON.stringify({
        formatVersion: 1,
        projectId: 'project-1',
        sourceId: 'doc-1',
        content: {
          kind: 'document',
          title,
          topics: [],
          importFormat: 'markdown',
          bodyFile: `${key}.md`
        }
      })
    )
    await writeRelative(root, `.opengalgame/inputs/documents/${key}.md`, '正文')
    const service = createService(root)
    const listed = await service.listProjectInputSources({ projectId: 'project-1' })
    expect(listed.sources[0]).toMatchObject({ sourceId: 'doc-1', name: title, readable: true })
  })

  it('当前 v4 编排通过工程检查，旧格式记为不支持而不是损坏', async () => {
    const root = await temporaryRoot()
    await seedProject(root)
    await writeDocument(root, 'doc-1')
    await writeArrangement(root, [{ cardId: 'doc', sourceId: 'doc-1' }])
    await writeRelative(
      root,
      `.opengalgame/canvases/${sourceKey('scene-1')}/${sourceKey('canvas-old')}.json`,
      JSON.stringify({
        formatVersion: 3,
        projectId: 'project-1',
        sceneId: 'scene-1',
        canvasId: 'canvas-old',
        viewport: { x: 0, y: 0, zoom: 1 },
        cards: [],
        relations: []
      })
    )
    const service = createService(root)
    const inspection = await service.inspectProjectFiles({ projectId: 'project-1' })
    expect(inspection.canvasArrangementFormatSupported).toBe(false)
    expect(inspection.diagnostics).toEqual([])
  })

  it('规范存储键下编码非法或超过 JSON 上限的编排在检查中保留损坏诊断', async () => {
    const root = await temporaryRoot()
    await seedProject(root)
    await writeDocument(root, 'doc-1')
    await writeArrangement(root, [], { sceneId: 'scene-1', canvasId: 'canvas-ok' })
    await writeRelative(
      root,
      `.opengalgame/canvases/${sourceKey('scene-1')}/${sourceKey('canvas-utf8')}.json`,
      Buffer.from([0xff])
    )
    const oversized = JSON.stringify({
      formatVersion: 4,
      projectId: 'project-1',
      sceneId: 'scene-1',
      canvasId: 'canvas-big',
      viewport: { x: 0, y: 0, zoom: 1 },
      cards: [{ kind: 'document' }],
      relations: []
    })
    await writeRelative(
      root,
      `.opengalgame/canvases/${sourceKey('scene-1')}/${sourceKey('canvas-big')}.json`,
      `${' '.repeat(MAX_JSON_BYTES + 1)}${oversized}`
    )
    const service = createService(root)
    const inspection = await service.inspectProjectFiles({ projectId: 'project-1' })
    expect(inspection.diagnostics).toEqual(
      expect.arrayContaining([
        { objectId: 'canvas-utf8', kind: 'damaged' },
        { objectId: 'canvas-big', kind: 'damaged' }
      ])
    )
    expect(inspection.diagnostics).toHaveLength(2)
  })

  it('空白标题的可识别来源在扫描中标为不可读，不让整次扫描失败', async () => {
    const root = await temporaryRoot()
    await seedProject(root)
    await writeDocument(root, 'doc-ok')
    const key = sourceKey('doc-blank')
    await writeRelative(
      root,
      `.opengalgame/inputs/sources/${key}.json`,
      JSON.stringify({
        formatVersion: 1,
        projectId: 'project-1',
        sourceId: 'doc-blank',
        content: {
          kind: 'document',
          title: '  ',
          topics: [],
          importFormat: 'markdown',
          bodyFile: `${key}.md`
        }
      })
    )
    await writeRelative(root, `.opengalgame/inputs/documents/${key}.md`, '正文')
    const service = createService(root)
    const listed = await service.listProjectInputSources({ projectId: 'project-1' })
    expect(listed.sources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ sourceId: 'doc-ok', readable: true }),
        expect.objectContaining({ sourceId: 'doc-blank', name: '  ', readable: false })
      ])
    )
    const inspection = await service.inspectProjectFiles({ projectId: 'project-1' })
    expect(inspection.diagnostics).toEqual(
      expect.arrayContaining([{ objectId: 'doc-blank', kind: 'damaged' }])
    )
    expect(inspection.diagnostics.some((item) => item.objectId === 'doc-ok')).toBe(false)
    await expect(
      service.readProjectInputSources({ projectId: 'project-1', sourceIds: ['doc-blank'] })
    ).rejects.toMatchObject({ code: ProjectFileErrorCodes.blankSourceContent })
  })

  it('来源目录不是目录时整次扫描失败，不是空目录', async () => {
    const root = await temporaryRoot()
    await seedProject(root)
    await mkdir(join(root, '.opengalgame', 'inputs'), { recursive: true })
    await writeFile(join(root, '.opengalgame', 'inputs', 'sources'), 'not-dir')
    const service = createService(root)
    await expect(service.listProjectInputSources({ projectId: 'project-1' })).rejects.toMatchObject(
      {
        code: ProjectFileErrorCodes.readFailed
      }
    )
  })

  it('按来源身份返回完整媒体字节，并拒绝文本、越界、链接、未知格式、超限和未登记工程', async () => {
    const root = await temporaryRoot()
    await seedProject(root)
    await writeAsset(root, 'img-1', 'image', PNG, 'roof.png')
    await writeDocument(root, 'doc-1')
    await writeAsset(root, 'bad-1', 'image', Buffer.from('not-media'), 'broken.png')
    const outside = await temporaryRoot()
    await writeFile(join(outside, 'secret.png'), PNG)
    const linkKey = sourceKey('link-1')
    await writeRelative(
      root,
      `.opengalgame/inputs/sources/${linkKey}.json`,
      JSON.stringify({
        formatVersion: 1,
        projectId: 'project-1',
        sourceId: 'link-1',
        content: {
          kind: 'asset',
          name: 'linked.png',
          fileType: 'image',
          description: '',
          fileId: 'file-link',
          mediaPath: 'assets/linked.png'
        }
      })
    )
    await mkdir(join(root, 'assets'), { recursive: true })
    try {
      await symlink(join(outside, 'secret.png'), join(root, 'assets', 'linked.png'))
    } catch {
      await symlink(join(outside, 'secret.png'), join(root, 'assets', 'linked.png'), 'file')
    }
    const hugeKey = sourceKey('huge-1')
    await writeRelative(
      root,
      `.opengalgame/inputs/sources/${hugeKey}.json`,
      JSON.stringify({
        formatVersion: 1,
        projectId: 'project-1',
        sourceId: 'huge-1',
        content: {
          kind: 'asset',
          name: 'huge.png',
          fileType: 'image',
          description: '',
          fileId: 'file-huge',
          mediaPath: 'assets/huge.png'
        }
      })
    )
    await writeFile(join(root, 'assets', 'huge.png'), PNG)
    const actualStat = fs.stat
    vi.spyOn(fs, 'stat').mockImplementation(async (path, options) => {
      const stats = await actualStat(path, options)
      if (!String(path).endsWith('huge.png') || typeof stats.size !== 'bigint') return stats
      return Object.assign(Object.create(Object.getPrototypeOf(stats)), stats, {
        size: BigInt(MAX_MEDIA_BYTES + 1)
      })
    })
    const service = createService(root)
    const media = await service.readProjectMedia({ projectId: 'project-1', sourceId: 'img-1' })
    expect(media).toMatchObject({
      sourceId: 'img-1',
      contentKind: 'image',
      fileName: 'roof.png',
      mediaType: 'image/png'
    })
    expect(media.bytes).toEqual(PNG)
    expect(JSON.stringify(media)).not.toContain(root)
    await expect(
      service.readProjectMedia({ projectId: 'project-1', sourceId: 'doc-1' })
    ).rejects.toMatchObject({
      code: ProjectFileErrorCodes.unsupportedFormat,
      message: '文本来源不能作为媒体读取'
    })
    await expect(
      service.readProjectMedia({ projectId: 'project-1', sourceId: 'link-1' })
    ).rejects.toMatchObject({ code: ProjectFileErrorCodes.readFailed })
    await expect(
      service.readProjectMedia({ projectId: 'project-1', sourceId: 'bad-1' })
    ).rejects.toMatchObject({
      code: ProjectFileErrorCodes.unsupportedFormat,
      message: '文件格式不受支持'
    })
    await expect(
      service.readProjectMedia({ projectId: 'project-1', sourceId: 'huge-1' })
    ).rejects.toMatchObject({
      code: ProjectFileErrorCodes.unsupportedFormat,
      message: '媒体文件超过 64 MiB，无法预览'
    })
    const unregistered = createService(await temporaryRoot())
    await expect(
      unregistered.readProjectMedia({ projectId: 'missing', sourceId: 'img-1' })
    ).rejects.toMatchObject({ code: 1209 })
  })
})
