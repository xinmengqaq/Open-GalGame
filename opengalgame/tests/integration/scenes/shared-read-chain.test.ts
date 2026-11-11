import * as fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import SceneParser, { ADD_NEXT_ARG_LIST, SCRIPT_CONFIG } from 'webgal-parser'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { SceneSourceSnapshot } from '@application/scenes/models/SceneSourceSnapshot'
import type { SceneSourceReaderGateway } from '@application/scenes/ports/SceneSourceReaderGateway'
import type { SceneScriptParserGateway } from '@application/scenes/ports/SceneScriptParserGateway'
import type { SceneAssetReferenceGateway } from '@application/scenes/ports/SceneAssetReferenceGateway'
import { AppException } from '@common/errors/AppException'
import { ErrorCodes } from '@common/errors/ErrorCodes'
import { SceneSourceReaderGatewayImpl } from '@infrastructure/scenes/SceneSourceReaderGatewayImpl'
import { SceneScriptParserGatewayImpl } from '@infrastructure/scenes/SceneScriptParserGatewayImpl'
import { SceneAssetReferenceGatewayImpl } from '@infrastructure/scenes/SceneAssetReferenceGatewayImpl'
import { runtimeAssetReference } from '@infrastructure/webgal/assetPath'
import {
  createWebgalSceneLocation,
  isWebgalSceneLocationCurrent
} from '@infrastructure/webgal/source/WebgalSceneLocator'

vi.mock('node:fs/promises', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:fs/promises')>())
}))

let root: string
const reader: SceneSourceReaderGateway = new SceneSourceReaderGatewayImpl()
const parser: SceneScriptParserGateway = new SceneScriptParserGatewayImpl()
const references: SceneAssetReferenceGateway = new SceneAssetReferenceGatewayImpl()

async function write(relativePath: string, text: string | Uint8Array): Promise<void> {
  const target = join(root, relativePath)
  await fs.mkdir(dirname(target), { recursive: true })
  await fs.writeFile(target, text)
}

async function read(entryFile = 'game/scene/start.txt'): Promise<SceneSourceSnapshot> {
  return reader.readSceneSource({ projectRoot: root, entryFile })
}

function git(...args: string[]): string {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' })
}

beforeEach(async () => {
  root = await fs.mkdtemp(join(tmpdir(), 'webgal-read-'))
})

afterEach(async () => {
  vi.restoreAllMocks()
  await fs.rm(root, { recursive: true, force: true })
})

describe('共享 WebGAL 真实读取链', () => {
  it('配音音量是合法数字参数，普通非法音量仍诊断且保留原值', async () => {
    await write(
      'game/scene/start.txt',
      'say:台词 -vocal=voice.ogg -volume=60;\nsay:台词 -vocal=voice.ogg -volume=loud;'
    )
    const scene = parser.parseSceneScript(await read())
    expect(scene.diagnostics.map((item) => [item.kind, item.range!.startLine])).toEqual([
      ['invalid-argument', 1]
    ])
    expect(scene.sentences[0].arguments).toContainEqual(
      expect.objectContaining({ key: 'volume', value: 60, originalValue: '60' })
    )
  })

  it('未转义运行时变量推迟参数类型判断，转义和不完整占位仍按字面值检查', async () => {
    await write(
      'game/scene/start.txt',
      [
        'bgm:theme.ogg -volume={vol};',
        'changeFigure:hero.png -clear={shouldClear};',
        'bgm:theme.ogg -volume=prefix{vol};',
        'bgm:theme.ogg -volume=\\{vol};',
        'changeFigure:hero.png -clear=\\{shouldClear};',
        'bgm:theme.ogg -volume={unterminated;',
        'bgm:theme.ogg -volume=loud;',
        'changeFigure:hero.png -clear=perhaps;',
        'bgm:theme.ogg -unknown={value};'
      ].join('\n')
    )
    const scene = parser.parseSceneScript(await read())
    expect(scene.diagnostics.map((item) => item.range!.startLine)).toEqual([3, 4, 5, 6, 7, 8])
    expect(scene.sentences[0].arguments).toContainEqual(
      expect.objectContaining({ key: 'volume', value: '{vol}', runtimeValue: '{vol}' })
    )
    expect(scene.sentences[1].arguments).toContainEqual(
      expect.objectContaining({ key: 'clear', value: '{shouldClear}' })
    )
    expect(scene.sentences[1].assets[0].isCleared).not.toBe(true)
  })

  it('intro 背景参数参与真实查询，保留引擎前缀并检查缺失与非法路径', async () => {
    await write(
      'game/scene/start.txt',
      [
        'intro:字幕 -backgroundImage=room.png;',
        'intro:字幕 -backgroundImage=missing.png;',
        'intro:字幕 -backgroundImage=../secret.png;',
        'intro:字幕;',
        'intro:字幕 -backgroundImage=none;',
        'intro:字幕 -backgroundImage=https://example.com/image.png;',
        'intro:字幕 -backgroundImage=;'
      ].join('\n')
    )
    await write('assets/background/room.png', 'image')
    const snapshot = await read()
    const scene = parser.parseSceneScript(snapshot)
    expect(scene.sentences[0].assets).toEqual([
      {
        kind: 'background',
        rawReference: 'room.png',
        runtimeReference: 'game/background/room.png',
        line: 0
      }
    ])
    expect(scene.sentences[3].assets).toEqual([])
    const facts = await references.checkSceneAssetReferences(snapshot, scene)
    expect(facts.map((fact) => [fact.sourceLine, fact.status])).toEqual([
      [0, 'present'],
      [1, 'missing'],
      [2, 'invalid-path'],
      [4, 'missing'],
      [5, 'invalid-path'],
      [6, 'missing']
    ])
    expect(scene.sentences[6].assets[0]).toMatchObject({
      rawReference: '0',
      runtimeReference: 'game/background/0'
    })
    expect(facts[0].relativePath).toBe('assets/background/room.png')
  })

  it('仅按命令事实清除，配音 none 是文件引用而空配音不是清除', async () => {
    await write(
      'game/scene/start.txt',
      [
        'say:台词 -vocal=none;',
        'say:台词 -vocal=;',
        'changeBg:none;',
        'changeFigure:missing.png -clear;',
        'playEffect:;',
        'bgm:none;'
      ].join('\n')
    )
    const snapshot = await read()
    const scene = parser.parseSceneScript(snapshot)
    expect(scene.sentences[0].assets[0]).toMatchObject({
      rawReference: 'none',
      runtimeReference: './game/vocal/none'
    })
    expect(scene.sentences[1].assets[0]).toMatchObject({
      rawReference: '',
      runtimeReference: './game/vocal/'
    })
    expect(scene.sentences.slice(2).every((sentence) => sentence.assets[0].isCleared)).toBe(true)
    expect(
      (await references.checkSceneAssetReferences(snapshot, scene)).map((fact) => fact.status)
    ).toEqual(['missing', 'invalid-path', 'cleared', 'cleared', 'cleared', 'cleared'])
    await write('game/vocal/none', 'actual vocal file')
    expect((await references.checkSceneAssetReferences(snapshot, scene))[0]).toMatchObject({
      status: 'present',
      relativePath: 'game/vocal/none'
    })
  })

  it('正式工程与指定候选根都读取当前真实内容，两个场景的正文、摘要和语句不同', async () => {
    await write('game/scene/start.txt', '小明:正式场景;\r\n')
    await write('candidate/game/scene/start.txt', '旁白:候选场景;\n')
    const formal = await read()
    const candidate = await reader.readSceneSource({ projectRoot: join(root, 'candidate') })
    expect(formal.entryFile.text).toBe('小明:正式场景;\r\n')
    expect(candidate.entryFile.text).toBe('旁白:候选场景;\n')
    expect(formal.digest).not.toBe(candidate.digest)
    expect(parser.parseSceneScript(formal).sentences[0].content).toBe('正式场景')
    expect(parser.parseSceneScript(candidate).sentences[0].content).toBe('候选场景')
    expect(formal.missingMetadataFiles).toEqual(['.opengalgame/scene-locks.json'])
    expect(await fs.readdir(root)).not.toContain('.git')
  })

  it.each(['\n', '\r\n'])(
    '保留 %j、中文转义、注释、多行占位、配音及官方引擎索引',
    async (newline) => {
      const fixture = await fs.readFile(resolve('tests/fixtures/webgal/read-chain.txt'), 'utf8')
      const text = fixture.replace(/\r?\n/g, newline)
      await write('game/scene/start.txt', text)
      const snapshot = await read()
      const scene = parser.parseSceneScript(snapshot)
      const official = new SceneParser(
        () => undefined,
        (name, type) => runtimeAssetReference(type, name),
        ADD_NEXT_ARG_LIST,
        SCRIPT_CONFIG
      ).parse(text, 'start', 'game/scene/start.txt')
      expect(snapshot.entryFile.bytes).toEqual(new Uint8Array(Buffer.from(text)))
      expect(snapshot.entryFile.size).toBe(Buffer.byteLength(text))
      expect(scene.sentences).toHaveLength(official.sentenceList.length)
      for (const [index, sentence] of scene.sentences.entries()) {
        const sdk = official.sentenceList[index]!
        expect(sentence.engineSentenceIndex).toBe(index)
        expect(sentence.sourceRange.startLine).toBe(sdk.startLine)
        expect(sentence.sourceRange.endLine).toBe(sdk.endLine)
        expect(sentence.isLineBreakHolder).toBe(sdk.isLineBreakHolder)
        const raw = text.slice(sentence.sourceRange.startOffset, sentence.sourceRange.endOffset)
        expect(raw).toBe(
          text
            .split(newline)
            .slice(sdk.startLine, sdk.endLine + 1)
            .join(newline)
        )
      }
      expect(scene.sentences[7]).toMatchObject({
        command: 'say',
        content: '你好;世界',
        inlineComment: '台词注释'
      })
      expect(scene.sentences[7].arguments).toContainEqual(
        expect.objectContaining({ key: 'speaker', value: '小明' })
      )
      expect(scene.sentences[7].assets).toContainEqual({
        kind: 'vocal',
        rawReference: 'voice.ogg',
        runtimeReference: './game/vocal/voice.ogg',
        line: 7
      })
      expect(scene.sentences[8].arguments).toContainEqual(
        expect.objectContaining({ key: 'concat', value: true })
      )
      expect(scene.sentences[9].rawContent).toContain('第一行\\' + newline + '  |第二行')
      expect(scene.sentences[9].sourceRange.endLine).toBe(11)
      expect(scene.sentences[10].isLineBreakHolder).toBe(true)
      expect(scene.sentences[11].isLineBreakHolder).toBe(true)
      expect(scene.sentences[12].engineSentenceIndex).toBe(12)
      expect(scene.sentences.map((sentence) => sentence.command)).toContain('jumpLabel')
      expect(scene.assets).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ kind: 'background', rawReference: 'room.png' }),
          expect.objectContaining({ kind: 'figure', rawReference: 'hero.png' }),
          expect.objectContaining({ kind: 'figure', rawReference: 'avatar.png' }),
          expect.objectContaining({ kind: 'bgm', rawReference: 'theme.ogg' }),
          expect.objectContaining({ kind: 'vocal', rawReference: 'bell.wav' }),
          expect.objectContaining({ kind: 'video', rawReference: 'opening.mp4' })
        ])
      )
      expect(scene.diagnostics).toEqual([])
      expect(scene.sentences[7].contentRange).toEqual({
        startOffset: scene.sentences[7].sourceRange.startOffset + '小明:'.length,
        endOffset: scene.sentences[7].sourceRange.startOffset + '小明:你好\\;世界'.length,
        startLine: 7,
        startColumn: '小明:'.length,
        endLine: 7,
        endColumn: '小明:你好\\;世界'.length
      })
      expect(
        text.slice(
          scene.sentences[7].contentRange!.startOffset,
          scene.sentences[7].contentRange!.endOffset
        )
      ).toBe('你好\\;世界')
      expect(scene.sentences[9].contentRange).toBeUndefined()
    }
  )

  it('不把说话人当未知命令，仅用显式命令声明诊断；未知参数保留原文及范围', async () => {
    await write(
      'game/scene/start.txt',
      'Alice:你好;\nnotACommand:原文;\nchangeBg:room.png -unsupported=3;'
    )
    const snapshot = await read()
    const scene = parser.parseSceneScript(snapshot, undefined, [
      { line: 1, command: 'notACommand' }
    ])
    expect(scene.sentences[0].command).toBe('say')
    expect(scene.sentences[1]).toMatchObject({
      command: 'say',
      commandRaw: 'notACommand',
      content: '原文'
    })
    expect(scene.sentences[2].arguments).toContainEqual(
      expect.objectContaining({ key: 'unsupported', value: 3 })
    )
    expect(scene.diagnostics.map((item) => item.kind)).toEqual([
      'unknown-command',
      'invalid-argument'
    ])
    for (const diagnostic of scene.diagnostics) {
      expect(
        snapshot.entryFile.text!.slice(diagnostic.range!.startOffset, diagnostic.range!.endOffset)
      ).toBe(diagnostic.rawText)
    }
    expect(parser.parseSceneScript(snapshot).diagnostics.map((item) => item.kind)).toEqual([
      'invalid-argument'
    ])
  })

  it('引用遵循 game 优先、assets 回退、不剥前缀、缺失、清除和外部语义', async () => {
    await write(
      'game/scene/start.txt',
      'changeBg:room.png;\nchangeFigure:hero.png;\nminiAvatar:missing.png;\nbgm:none;\nplayEffect:bell.wav;\nplayVideo:https://example.com/open.mp4;\nchangeBg:game/background/room.png;'
    )
    await write('game/background/room.png', 'game')
    await write('assets/background/room.png', 'assets')
    await write('assets/figure/hero.png', 'figure')
    await write('assets/vocal/bell.wav', 'sound')
    const snapshot = await read()
    const scene = parser.parseSceneScript(snapshot)
    const facts = await references.checkSceneAssetReferences(snapshot, scene)
    const location = createWebgalSceneLocation(scene, 0)
    expect(location).toMatchObject({
      sourceFile: 'game/scene/start.txt',
      contentDigest: snapshot.digest,
      parserVersion: '4.6.5',
      engineVersion: '4.6.5',
      engineSentenceIndex: 0,
      sourceRange: { startOffset: 0, endOffset: 18, startLine: 0, endLine: 0 }
    })
    expect(
      snapshot.entryFile.text!.slice(
        location.sourceRange.startOffset,
        location.sourceRange.endOffset
      )
    ).toBe('changeBg:room.png;')
    expect(isWebgalSceneLocationCurrent(location, snapshot)).toBe(true)
    expect(facts.map((fact) => fact.status)).toEqual([
      'present',
      'present',
      'missing',
      'cleared',
      'present',
      'external',
      'missing'
    ])
    expect(facts[0].relativePath).toBe('game/background/room.png')
    expect(facts[1].relativePath).toBe('assets/figure/hero.png')
    expect(facts[4]).toMatchObject({
      kind: 'vocal',
      rawReference: 'bell.wav',
      runtimeReference: './game/vocal/bell.wav'
    })
  })

  it('遵守已核对引擎参数，清除立绘不报缺失，未知参数和非法数值可定位', async () => {
    await write(
      'game/scene/start.txt',
      [
        'say:台词 -figureId=hero -left -voice.opus;',
        'changeBg:room.png -unlockname=背景 -order=1 -ignoreDefault;',
        'changeFigure:missing.png -clear -mouthOpen=mouth.png;',
        'changeFigureDiff:hero.png -id=hero -continue -mouthClose=close.png;',
        'bgm:theme.ogg -unlockname=音乐 -series=主题;',
        'wait:100 -nobreak;',
        'setTransform:{} -target=hero -parallel -transformFrom=current;',
        'bgm:theme.ogg -volume=loud;',
        'changeFigureDiff:hero.png -duration=200;',
        'changeFigure:duplicate.png -clear=false -clear;'
      ].join('\n')
    )
    const snapshot = await read()
    const scene = parser.parseSceneScript(snapshot)
    expect(scene.diagnostics.map((item) => item.range!.startLine)).toEqual([7, 8])
    expect(scene.sentences[0].assets[0].rawReference).toBe('voice.opus')
    const facts = await references.checkSceneAssetReferences(snapshot, scene)
    expect(facts.find((fact) => fact.sourceLine === 2)?.status).toBe('cleared')
    expect(facts.find((fact) => fact.sourceLine === 9)?.status).toBe('missing')
    expect(scene.sentences[7].arguments).toContainEqual(
      expect.objectContaining({ key: 'volume', value: 'loud', originalValue: 'loud' })
    )
  })

  it('引用查询故障保留原因，不把技术故障当缺失；不同快照不能混用', async () => {
    await write('game/scene/start.txt', 'changeBg:room.png;')
    const snapshot = await read()
    const scene = parser.parseSceneScript(snapshot)
    await write('game/scene/start.txt', 'changeBg:other.png;')
    await expect(references.checkSceneAssetReferences(await read(), scene)).rejects.toMatchObject({
      code: ErrorCodes.operationConflict
    })
    const failure = Object.assign(new Error('io error'), { code: 'EIO' })
    vi.spyOn(fs, 'stat').mockRejectedValue(failure)
    await expect(references.checkSceneAssetReferences(snapshot, scene)).rejects.toMatchObject({
      cause: { kind: 'read-failed', cause: failure }
    })
  })

  it('控制、场景引用和已停止支持的命令仍保留；读取不追踪或执行控制流', async () => {
    await write(
      'game/scene/start.txt',
      [
        'choose:继续:next.txt|跳过:endLabel;',
        'callScene:called.txt -name=小明 -count=2 -writeReturnTo=answer;',
        'changeScene:next.txt;',
        'getUserInput:name -title=姓名 -defaultValue=小明;',
        'if:flag -when=flag;',
        'chooseLabel:start;'
      ].join('\n')
    )
    await write('game/scene/next.txt', '旁白:下一场景;')
    const snapshot = await read()
    const scene = parser.parseSceneScript(snapshot)
    expect(snapshot.files.filter((file) => file.kind !== 'metadata')).toHaveLength(1)
    expect(scene.sentences.map((sentence) => sentence.command)).toEqual([
      'choose',
      'callScene',
      'changeScene',
      'getUserInput',
      'if',
      'chooseLabel'
    ])
    expect(scene.sentences[0].subScenes).toEqual(['next.txt'])
    expect(scene.diagnostics.map((item) => [item.kind, item.range!.startLine])).toEqual([
      ['unsupported-command', 4],
      ['unsupported-command', 5]
    ])
    const facts = await references.checkSceneAssetReferences(snapshot, scene)
    expect(facts.map((fact) => [fact.rawReference, fact.status])).toEqual([
      ['next.txt', 'present'],
      ['called.txt', 'missing'],
      ['next.txt', 'present']
    ])
  })

  it('空内容、UTF-8 BOM、表情符号和参数词面保留准确', async () => {
    await write('game/scene/start.txt', '')
    expect(parser.parseSceneScript(await read()).diagnostics).toEqual([])
    const text = '\uFEFF旁白:中文😀 -voice.wav;\r\nbgm:music.ogg -volume=060 -volume=20;'
    await write('game/scene/start.txt', text)
    const snapshot = await read()
    const scene = parser.parseSceneScript(snapshot)
    expect(snapshot.entryFile.text).toBe(text)
    expect(scene.sentences[0].content).toBe('中文😀')
    expect(scene.sentences[1].arguments).toContainEqual(
      expect.objectContaining({ key: 'volume', value: 60, originalValue: '060' })
    )
    expect(scene.sentences[1].arguments).toContainEqual(
      expect.objectContaining({ key: 'volume', value: 20, originalValue: '20' })
    )
    expect(
      text.slice(
        scene.sentences[0].sourceRange.startOffset,
        scene.sentences[0].sourceRange.endOffset
      )
    ).toBe(text.split('\r\n')[0])
  })

  it('缺失元信息在读取过程中出现也要求重读', async () => {
    await write('game/scene/start.txt', '旁白:原内容;')
    const actualRead = fs.readFile
    let created = false
    vi.spyOn(fs, 'readFile').mockImplementation(async (...args: Parameters<typeof fs.readFile>) => {
      const bytes = await actualRead(...args)
      if (!created) {
        created = true
        await write('.opengalgame/scene-locks.json', '{"scenes":[]}')
      }
      return bytes
    })
    await expect(read()).rejects.toMatchObject({ cause: { kind: 'inconsistent-read' } })
  })

  it.each([
    '../secret.png',
    '/secret.png',
    'C:\\secret.png',
    '..\\secret.png',
    '//server/share.png'
  ])('拒绝非法素材路径 %j', async (reference) => {
    await write('game/scene/start.txt', `changeBg:${reference};`)
    const snapshot = await read()
    const facts = await references.checkSceneAssetReferences(
      snapshot,
      parser.parseSceneScript(snapshot)
    )
    expect(facts[0].status).toBe('invalid-path')
  })

  it('元信息、脚本修改、插入和删除都使旧定位失效', async () => {
    await write('game/scene/start.txt', '旁白:第一句;\n旁白:第二句;')
    await write('.opengalgame/scene-locks.json', '{"scenes":[]}')
    const original = await read()
    const scene = parser.parseSceneScript(original)
    const location = createWebgalSceneLocation(scene, 1)
    expect(isWebgalSceneLocationCurrent(location, original)).toBe(true)
    expect(location).toMatchObject({
      contentDigest: original.digest,
      parserVersion: '4.6.5',
      engineVersion: '4.6.5',
      engineSentenceIndex: 1
    })
    await write(
      '.opengalgame/scene-locks.json',
      '{"scenes":[{"sceneId":"s","lockState":"locked"}]}'
    )
    const metadataChanged = await read()
    expect(metadataChanged.entryFile.digest).toBe(original.entryFile.digest)
    expect(metadataChanged.digest).not.toBe(original.digest)
    expect(isWebgalSceneLocationCurrent(location, metadataChanged)).toBe(false)
    for (const text of ['旁白:改写;', ';插入\n旁白:第一句;\n旁白:第二句;', '旁白:第二句;']) {
      await write('game/scene/start.txt', text)
      expect(isWebgalSceneLocationCurrent(location, await read())).toBe(false)
    }
  })

  it.each(['game/scene/start.txt', '.opengalgame/scene-locks.json'])(
    '读取中 %s 变化明确失败，不返回混合快照',
    async (changedPath) => {
      await write('game/scene/start.txt', '旁白:原内容;')
      await write('.opengalgame/scene-locks.json', '{"scenes":[]}')
      const actualRead = fs.readFile
      let changed = false
      vi.spyOn(fs, 'readFile').mockImplementation(
        async (...args: Parameters<typeof fs.readFile>) => {
          const bytes = await actualRead(...args)
          if (!changed) {
            changed = true
            await write(
              changedPath,
              changedPath.endsWith('.json') ? '{"scenes":[],"changed":true}' : '旁白:读取中修改;'
            )
          }
          return bytes
        }
      )
      await expect(read()).rejects.toMatchObject({
        code: ErrorCodes.operationConflict,
        cause: { kind: 'inconsistent-read' }
      })
    }
  )

  it('缺失文件、非法 UTF-8 和读取故障转换为 AppException 并保留原因', async () => {
    await expect(read()).rejects.toMatchObject({
      cause: { kind: 'missing-entry', cause: { code: 'ENOENT' } }
    })
    await write('game/scene/start.txt', new Uint8Array([0xc3, 0x28]))
    await expect(read()).rejects.toMatchObject({
      cause: { kind: 'invalid-encoding', cause: expect.any(TypeError) }
    })
    await write('game/scene/start.txt', '旁白:内容;')
    const failure = Object.assign(new Error('read failed'), { code: 'EIO' })
    vi.spyOn(fs, 'readFile').mockRejectedValue(failure)
    try {
      await read()
      expect.fail('应读取失败')
    } catch (error) {
      expect(error).toBeInstanceOf(AppException)
      expect(error).toMatchObject({ cause: { kind: 'read-failed', cause: failure } })
    }
  })

  it('多源文件纳入同一摘要；不存在的显式脚本失败，缺失元信息保留事实', async () => {
    await write('game/scene/start.txt', '旁白:入口;')
    await write('game/scene/other.txt', '旁白:另一文件;')
    const snapshot = await reader.readSceneSource({
      projectRoot: root,
      sceneFiles: ['game/scene/other.txt'],
      metadataFiles: ['meta.json']
    })
    expect(parser.parseSceneScript(snapshot, 'game/scene/other.txt').sentences[0].content).toBe(
      '另一文件'
    )
    expect(snapshot.missingMetadataFiles).toEqual(['meta.json'])
    await expect(
      reader.readSceneSource({ projectRoot: root, sceneFiles: ['missing.txt'] })
    ).rejects.toMatchObject({ cause: { kind: 'missing-file' } })
  })

  it('读取后的状态核对发生 I/O 故障时保留读取失败分类', async () => {
    await write('game/scene/start.txt', '旁白:内容;')
    const actualRead = fs.readFile
    const actualStat = fs.stat
    let bytesRead = false
    vi.spyOn(fs, 'readFile').mockImplementation(async (...args: Parameters<typeof fs.readFile>) => {
      const bytes = await actualRead(...args)
      bytesRead = true
      return bytes
    })
    const failure = Object.assign(new Error('stat failed'), { code: 'EIO' })
    vi.spyOn(fs, 'stat').mockImplementation(async (...args: Parameters<typeof fs.stat>) => {
      if (bytesRead) throw failure
      return actualStat(...args)
    })
    await expect(read()).rejects.toMatchObject({
      code: ErrorCodes.internalError,
      cause: { kind: 'read-failed', cause: failure }
    })
  })

  it('读取、解析和检查引用不改变真实字节、Git HEAD、索引及未提交状态', async () => {
    await write('game/scene/start.txt', '旁白:提交内容;')
    git('init', '--quiet')
    git('config', 'user.name', 'Read test')
    git('config', 'user.email', 'read@example.test')
    git('add', '.')
    git('commit', '--quiet', '-m', 'fixture')
    await write('game/scene/start.txt', '旁白:未提交中文;\r\n')
    await write('unrelated.txt', '已暂存')
    git('add', 'unrelated.txt')
    await write('untracked.txt', '未跟踪')
    const bytes = await fs.readFile(join(root, 'game/scene/start.txt'))
    const head = git('rev-parse', 'HEAD')
    const index = await fs.readFile(join(root, '.git/index'))
    const status = git('status', '--porcelain=v1')
    const snapshot = await read()
    const scene = parser.parseSceneScript(snapshot)
    await references.checkSceneAssetReferences(snapshot, scene)
    expect(scene.sentences[0].content).toBe('未提交中文')
    expect(await fs.readFile(join(root, 'game/scene/start.txt'))).toEqual(bytes)
    expect(git('rev-parse', 'HEAD')).toBe(head)
    expect(await fs.readFile(join(root, '.git/index'))).toEqual(index)
    expect(git('status', '--porcelain=v1')).toBe(status)
  })

  it('默认读取保留外来角色简写和裸行，生成契约才报告未知命令与非显式对白', async () => {
    await write(
      'game/scene/start.txt',
      [
        '林:明天见。;',
        ':车站的灯亮了。;',
        '傍晚的空地;',
        'playBgm:theme.ogg;',
        'stopBgm:;',
        'bgm:theme.ogg -volume=60;',
        'bgm:none;',
        'playEffect:bell.ogg;',
        'say:明天见。 -speaker=林;',
        'say:车站的灯亮了。 -clear;',
        ';演出说明'
      ].join('\n')
    )
    const snapshot = await read()
    const shared = parser.parseSceneScript(snapshot)
    expect(shared.diagnostics).toEqual([])
    expect(shared.sentences.map((sentence) => [sentence.command, sentence.commandRaw])).toEqual([
      ['say', '林'],
      ['say', ''],
      ['say', '傍晚的空地'],
      ['say', 'playBgm'],
      ['say', 'stopBgm'],
      ['bgm', 'bgm'],
      ['bgm', 'bgm'],
      ['playEffect', 'playEffect'],
      ['say', 'say'],
      ['say', 'say'],
      ['comment', 'comment']
    ])

    const generated = parser.parseSceneScript(snapshot, undefined, {
      syntaxContract: 'generated-candidate'
    })
    expect(generated.sentences.map((sentence) => sentence.command)).toEqual(
      shared.sentences.map((sentence) => sentence.command)
    )
    expect(generated.diagnostics.map((item) => [item.kind, item.range!.startLine])).toEqual([
      ['unsupported-dialogue', 1],
      ['unknown-command', 3],
      ['unknown-command', 4]
    ])
    expect(generated.diagnostics[1]).toMatchObject({
      message: '命令 playBgm 不受当前解析器支持，请改用已支持命令'
    })
    expect(generated.diagnostics[2]).toMatchObject({
      message: '命令 stopBgm 不受当前解析器支持，请改用已支持命令'
    })
  })

  it('生成契约的显式对白、旁白、注释和兼容命令不产生语法问题', async () => {
    await write(
      'game/scene/start.txt',
      [
        'changeBg:room.png;',
        'say:明天见。 -speaker=林;',
        'say:车站的灯亮了。 -clear;',
        ';演出说明',
        'bgm:theme.ogg;',
        'playEffect:bell.ogg;',
        'bgm:none;',
        'end;'
      ].join('\n')
    )
    const scene = parser.parseSceneScript(await read(), undefined, {
      syntaxContract: 'generated-candidate'
    })
    expect(scene.diagnostics).toEqual([])
    expect(scene.sentences[1]).toMatchObject({ command: 'say', content: '明天见。' })
    expect(scene.sentences[2]).toMatchObject({ command: 'say', content: '车站的灯亮了。' })
  })

  it('生成契约把空 speaker 和单独 say 报成可修正对白，不改公共解析', async () => {
    await write('game/scene/start.txt', 'say:车站的灯亮了。;\nsay:车站的灯亮了。 -speaker=;')
    const snapshot = await read()
    expect(parser.parseSceneScript(snapshot).diagnostics).toEqual([])
    const scene = parser.parseSceneScript(snapshot, undefined, {
      syntaxContract: 'generated-candidate'
    })
    expect(scene.diagnostics.map((item) => item.kind)).toEqual([
      'unsupported-dialogue',
      'unsupported-dialogue'
    ])
    expect(scene.sentences.map((sentence) => sentence.command)).toEqual(['say', 'say'])
  })
})
