import { execFile, execFileSync, spawn } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { build } from 'esbuild'
import { afterEach, describe, expect, it } from 'vitest'

import { ProjectVersioningApplicationServiceImpl } from '@application/project-versioning/services/impl/ProjectVersioningApplicationServiceImpl'
import { SceneExportApplicationServiceImpl } from '@application/scene-export/services/impl/SceneExportApplicationServiceImpl'
import { createProjectVersioningGateways } from '@infrastructure/project-versioning/createProjectVersioningGateways'
import { encodeStorageKey } from '@infrastructure/project-files/projectFilePaths'
import { writeProjectRegistrations } from '@infrastructure/projects/projectRegistrations'
import { LocalSceneExportSourceGateway } from '@infrastructure/scene-export/LocalSceneExportSourceGateway'
import {
  maximizeCopiedTemplateWindow,
  TerreWindowsScenePackager,
  writeCopiedTemplateBaseStyle,
  writeSingleScene as writeSingleSceneForTest
} from '@infrastructure/scene-export/TerreWindowsScenePackager'
import { LocalSceneDialogueRevisionGateway } from '@infrastructure/scene-preview/LocalSceneDialogueRevisionGateway'
import { LocalPreviewSaveVersionGateway } from '@infrastructure/scene-preview/LocalPreviewSaveVersionGateway'
import { LocalScenePreviewSourceGateway } from '@infrastructure/scene-preview/LocalScenePreviewSourceGateway'
import { SceneAssetReferenceGatewayImpl } from '@infrastructure/scenes/SceneAssetReferenceGatewayImpl'
import { SceneScriptParserGatewayImpl } from '@infrastructure/scenes/SceneScriptParserGatewayImpl'
import { SceneSourceReaderGatewayImpl } from '@infrastructure/scenes/SceneSourceReaderGatewayImpl'
import { RegisteredSceneLocationGatewayImpl } from '@infrastructure/scenes/RegisteredSceneLocationGatewayImpl'
import { AppException } from '@common/errors/AppException'
import { SceneExportErrorCodes } from '@domain/scene-export/errors/SceneExportErrorCodes'

const roots: string[] = []
const scene = { projectId: 'project-1', sceneId: 'scene-1' }
const script = '小明:已保存的一句 -figure=hero.png -next;\r\nchangeBg:room.webp;\r\n'
const unsaved = {
  ...scene,
  contentBasis: { digest: 'a'.repeat(64), parserVersion: '4.6.5', engineVersion: '4.6.5' },
  versionReference: { kind: 'preview-save' as const, requestId: 'missing-save' }
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('最小 Windows 场景导出', () => {
  it('未保存时不调用打包，也不留下可运行产物', async () => {
    const world = await registeredScene()
    let packaged = 0
    const service = exporter(world.userDirectory, {
      async packageWindowsScene() {
        packaged += 1
        return { status: 'unavailable', reason: 'windowsPackagerUnavailable', message: '未调用' }
      }
    })

    await expect(service.exportSavedScene(unsaved)).rejects.toMatchObject({
      code: SceneExportErrorCodes.saveNotCommitted
    })
    expect(packaged).toBe(0)
    await expect(readFile(join(world.projectRoot, 'WebGAL.exe'))).rejects.toThrow()
  })

  it('保存成功但没有 Terre Windows 模板时返回能力不可用，不生成假可执行文件', async () => {
    const world = await registeredScene()
    const saved = await saveScene(world)
    const previous = process.env.OPENGALGAME_TERRE_WINDOWS_RELEASE
    process.env.OPENGALGAME_TERRE_WINDOWS_RELEASE = join(world.root, 'missing-terre.zip')
    try {
      const service = exporter(
        world.userDirectory,
        new TerreWindowsScenePackager(world.userDirectory)
      )
      const result = await service.exportSavedScene(saved)
      expect(result).toEqual({
        status: 'unavailable',
        reason: 'windowsPackagerUnavailable',
        message: '当前没有可调用的 Windows 桌面打包入口'
      })
    } finally {
      if (previous === undefined) delete process.env.OPENGALGAME_TERRE_WINDOWS_RELEASE
      else process.env.OPENGALGAME_TERRE_WINDOWS_RELEASE = previous
    }
    await expect(readFile(join(world.projectRoot, 'WebGAL.exe'))).rejects.toThrow()
    await expect(readFile(join(world.userDirectory, 'WebGAL.exe'))).rejects.toThrow()
  })

  it('Electron 主进程导出和覆盖已有 Windows 包时保留真实 ASAR 文件及保存内容', async () => {
    const release = process.env.LOCALAPPDATA
      ? join(
          process.env.LOCALAPPDATA,
          'opengalgame',
          'templates',
          'terre-4.6.5',
          'WebGAL_Terre_Windows_4.6.5.zip'
        )
      : ''
    const world = await registeredScene()
    const saved = await saveScene(world)
    const previous = process.env.OPENGALGAME_TERRE_WINDOWS_RELEASE
    process.env.OPENGALGAME_TERRE_WINDOWS_RELEASE = release
    try {
      const electronMain = join(world.root, 'export-main.mjs')
      const sourceFile = join(world.root, 'export-source.json')
      const resultFile = join(world.root, 'export-result.json')
      await symlink(
        join(process.cwd(), 'node_modules'),
        join(world.root, 'node_modules'),
        'junction'
      )
      await build({
        stdin: {
          contents: `
            import { app } from 'electron'
            import { readFile, writeFile } from 'node:fs/promises'
            import { TerreWindowsScenePackager } from './src/infrastructure/scene-export/TerreWindowsScenePackager'
            async function main() {
              await app.whenReady()
              const source = JSON.parse(await readFile(process.argv[2], 'utf8'))
              const result = await new TerreWindowsScenePackager(process.argv[4]).packageWindowsScene(source)
              await writeFile(process.argv[3], JSON.stringify(result))
              app.exit(result.status === 'succeeded' ? 0 : 1)
            }
            void main().catch(error => {
              console.error(error)
              app.exit(1)
            })
          `,
          resolveDir: process.cwd()
        },
        outfile: electronMain,
        tsconfig: join(process.cwd(), 'tsconfig.node.json'),
        bundle: true,
        platform: 'node',
        format: 'esm',
        packages: 'external'
      })
      const service = exporter(world.userDirectory, {
        async packageWindowsScene(source) {
          await writeFile(sourceFile, JSON.stringify(source))
          const env = { ...process.env }
          delete env.ELECTRON_RUN_AS_NODE
          await promisify(execFile)(
            createRequire(import.meta.url)('electron') as string,
            [electronMain, sourceFile, resultFile, world.userDirectory],
            { env, timeout: 30_000, windowsHide: true }
          )
          return JSON.parse(await readFile(resultFile, 'utf8'))
        }
      })
      await expect(service.exportSavedScene(saved)).resolves.toMatchObject({ status: 'succeeded' })
      const result = await service.exportSavedScene(saved)
      expect(result.status).toBe('succeeded')
      if (result.status !== 'succeeded') return
      expect(result.artifact.executableName).toBe('WebGAL.exe')
      expect(result.artifact.bytes).toBeGreaterThan(0)
      expect(result.artifact.directoryName).toMatch(/^scene-[a-f0-9]{16}$/)
      expect(result.artifact.entryRelativePath).toBe('game/scene/start.txt')
      const output = join(world.userDirectory, 'exports', result.artifact.directoryName)
      expect(result.artifact.directoryPath).toBe(output)
      expect(JSON.stringify(result)).not.toContain(world.projectRoot)
      const packed = await readFile(join(output, 'resources', 'app.asar'))
      expect(packed.byteLength).toBeGreaterThan(0)
      const listing = execFileSync(
        process.execPath,
        [
          '-e',
          "const asar=require('@electron/asar'); const root=process.argv[1]; const dest=require('node:os').tmpdir()+'/terre-check'; asar.extractAll(root+'/resources/app.asar', dest); const fs=require('node:fs'); const base=dest+'/public/game/'; console.log(fs.readFileSync(base+'scene/start.txt','utf8')); console.log(fs.readFileSync(base+'figure/hero.png').toString('hex')); console.log(fs.readFileSync(base+'background/room.webp').toString('hex')); console.log(fs.readFileSync(dest+'/public/webgal-engine.json','utf8')); console.log('__USER_STYLE__'+fs.readFileSync(base+'userStyleSheet.css','utf8')); console.log('__MAIN__'+fs.readFileSync(dest+'/main.js','utf8'));",
          output
        ],
        { cwd: join(process.cwd(), 'node_modules', '@electron', 'asar'), encoding: 'utf8' }
      )
      expect(listing).toContain('导出前保存的一句')
      expect(listing).toContain('010203')
      expect(listing).toContain('"version": "4.6.5"')
      expect(listing).toContain('changeBg:')
      expect(listing).not.toContain(world.projectRoot)
      expect(listing).toContain('__USER_STYLE__html,body{background:#000}')
      expect(listing).not.toMatch(/#root\s*\{|\.App\s*\{|#pixiCont|canvas\s*\{[^}]*width/i)
      expect(listing).toMatch(/__MAIN__[\s\S]*setBounds\(area\);\s*win\.maximize\(\)/)
      expect(listing).not.toMatch(/__MAIN__[\s\S]*width:\s*1600/)
      const child = spawn(join(output, 'WebGAL.exe'), [], {
        cwd: output,
        windowsHide: false,
        stdio: 'ignore',
        detached: true
      })
      child.unref()
      const started = await new Promise<boolean>((resolve) => {
        child.once('spawn', () => resolve(true))
        child.once('error', () => resolve(false))
      })
      expect(started).toBe(true)
      expect(child.pid).toBeGreaterThan(0)
      execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true })
      await new Promise((resolve) => setTimeout(resolve, 500))
    } finally {
      if (previous === undefined) delete process.env.OPENGALGAME_TERRE_WINDOWS_RELEASE
      else process.env.OPENGALGAME_TERRE_WINDOWS_RELEASE = previous
    }
  }, 40_000)

  it('导出样式不再覆盖舞台尺寸，只保留黑色底色', async () => {
    const root = await mkdtemp(join(tmpdir(), 'scene-export-style-'))
    roots.push(root)
    const publicDir = join(root, 'public')
    await mkdir(join(publicDir, 'game'), { recursive: true })
    const stylePath = join(publicDir, 'game/userStyleSheet.css')
    await writeFile(
      stylePath,
      'html,body,#root,.App{width:100%;height:100%;margin:0;overflow:hidden}#pixiContainer,canvas{width:100%!important;height:100%!important}\n'
    )

    await writeCopiedTemplateBaseStyle(publicDir)

    const css = await readFile(stylePath, 'utf8')
    expect(css).toBe('html,body{background:#000}\n')
    expect(css).not.toMatch(/#root|\.App|#pixiCont|canvas/i)
  })

  it('导出复制模板的主进程窗口仍最大化到工作区', async () => {
    const root = await mkdtemp(join(tmpdir(), 'scene-export-main-'))
    roots.push(root)
    const mainPath = join(root, 'main.js')
    await writeFile(
      mainPath,
      "const win = new BrowserWindow({ width: 1600, height: 900, useContentSize: true })\nwin.loadFile('index.html')\n"
    )

    await maximizeCopiedTemplateWindow(mainPath)

    const main = await readFile(mainPath, 'utf8')
    expect(main).not.toContain('width: 1600')
    expect(main).not.toContain('height: 900')
    expect(main).not.toContain('useContentSize')
    expect(main).toContain('win.setBounds(area); win.maximize();')
    expect(main).toContain('win.loadFile')
  })

  it('候选、草稿和工程外路径在保存核对前拒绝', async () => {
    const world = await registeredScene()
    const service = exporter(world.userDirectory, new TerreWindowsScenePackager())
    await expect(
      service.exportSavedScene({ ...unsaved, candidateSnapshotId: 'candidate-1' } as never)
    ).rejects.toMatchObject({ code: SceneExportErrorCodes.exportInputRejected })
    await expect(
      service.exportSavedScene({ ...unsaved, outputDirectory: '../outside' } as never)
    ).rejects.toMatchObject({ code: SceneExportErrorCodes.exportInputRejected })
  })

  it('保存后的存储键引用分离来源和包路径，并逐字节复制', async () => {
    const sourceId = '11111111-1111-4111-8111-111111111111'
    const storageKey = encodeStorageKey(sourceId)
    const fileName = 'sora_01.jpg'
    const bytes = Uint8Array.of(4, 5, 6, 7)
    const sourcePath = `assets/${storageKey}/${fileName}`
    const world = await registeredScene({
      script: `小明:原来的一句;\r\nchangeBg:${storageKey}/${fileName};\r\n`,
      assets: [{ relativePath: sourcePath, bytes }]
    })
    const saved = await saveScene(world)
    const locations = new RegisteredSceneLocationGatewayImpl(world.userDirectory)
    const exported = await new LocalSceneExportSourceGateway(
      world.userDirectory,
      versioning(world.userDirectory),
      new LocalScenePreviewSourceGateway(
        locations,
        new SceneSourceReaderGatewayImpl(),
        new SceneScriptParserGatewayImpl(),
        new SceneAssetReferenceGatewayImpl()
      )
    ).readSavedScene(saved)
    expect(exported.referencedAssets).toEqual([
      { sourcePath, packagePath: `game/background/${storageKey}/${fileName}` }
    ])
    const publicDir = join(world.root, 'public')
    await mkdir(join(publicDir, 'game/animation'), { recursive: true })
    await mkdir(join(publicDir, 'game/template'), { recursive: true })
    await mkdir(join(publicDir, 'game/tex'), { recursive: true })
    await writeFile(join(publicDir, 'game/userStyleSheet.css'), '')
    await writeSingleSceneForTest(publicDir, exported, world.userDirectory)
    expect([...(await readFile(join(publicDir, 'game/background', storageKey, fileName)))]).toEqual(
      [...bytes]
    )
    await expect(
      writeSingleSceneForTest(
        publicDir,
        {
          ...exported,
          referencedAssets: [
            {
              sourcePath: 'assets/missing/sora_01.jpg',
              packagePath: `game/background/${storageKey}/${fileName}`
            }
          ]
        },
        world.userDirectory
      )
    ).rejects.toThrow()
  })

  it('缺失或用途不明的引用不能进入可导出结果', async () => {
    const world = await registeredScene({ script: '小明:原来的一句;\r\nchangeBg:missing.webp;\r\n' })
    const saved = await saveScene(world)
    const locations = new RegisteredSceneLocationGatewayImpl(world.userDirectory)
    await expect(
      new LocalSceneExportSourceGateway(
        world.userDirectory,
        versioning(world.userDirectory),
        new LocalScenePreviewSourceGateway(
          locations,
          new SceneSourceReaderGatewayImpl(),
          new SceneScriptParserGatewayImpl(),
          new SceneAssetReferenceGatewayImpl()
        )
      ).readSavedScene(saved)
    ).rejects.toMatchObject({ code: SceneExportErrorCodes.exportFailed })
  })
})

function exporter(
  userDirectory: string,
  packager: ConstructorParameters<typeof SceneExportApplicationServiceImpl>[0]['packager']
): SceneExportApplicationServiceImpl {
  const locations = new RegisteredSceneLocationGatewayImpl(userDirectory)
  const sources = new SceneSourceReaderGatewayImpl()
  const parser = new SceneScriptParserGatewayImpl()
  return new SceneExportApplicationServiceImpl({
    sources: new LocalSceneExportSourceGateway(
      userDirectory,
      versioning(userDirectory),
      new LocalScenePreviewSourceGateway(
        locations,
        sources,
        parser,
        new SceneAssetReferenceGatewayImpl()
      )
    ),
    packager
  })
}

function versioning(userDirectory: string): ProjectVersioningApplicationServiceImpl {
  return new ProjectVersioningApplicationServiceImpl({
    ...createProjectVersioningGateways(userDirectory),
    nextId: () => `op-export-${Math.random().toString(16).slice(2)}`
  })
}

async function saveScene(world: { userDirectory: string }): Promise<{
  projectId: string
  sceneId: string
  contentBasis: { digest: string; parserVersion: string; engineVersion: string }
  versionReference: { kind: 'preview-save'; requestId: string }
}> {
  const locations = new RegisteredSceneLocationGatewayImpl(world.userDirectory)
  const reader = new LocalScenePreviewSourceGateway(
    locations,
    new SceneSourceReaderGatewayImpl(),
    new SceneScriptParserGatewayImpl(),
    new SceneAssetReferenceGatewayImpl()
  )
  const source = await reader.readScenePreviewSource(scene)
  const dialogue = source.dialogues[0]
  const revision = await new LocalSceneDialogueRevisionGateway().prepareDialogueRevision(source, {
    scene,
    changedEdits: dialogue ? [{ dialogueId: dialogue.dialogueId, text: '导出前保存的一句' }] : []
  })
  const gateway = new LocalPreviewSaveVersionGateway(
    world.userDirectory,
    versioning(world.userDirectory),
    reader
  )
  const saved = await gateway.commitPreviewSave({
    ...scene,
    requestId: 'request-1',
    baseContentBasis: source.contentBasis,
    editsSnapshot: JSON.stringify(
      dialogue ? [{ dialogueId: dialogue.dialogueId, text: '导出前保存的一句' }] : []
    ),
    committedEdits: dialogue ? [{ dialogueId: dialogue.dialogueId, text: '导出前保存的一句' }] : [],
    revision
  })
  if (saved.status !== 'committed') throw new AppException({ code: 1, msg: '测试保存没有成功' })
  return {
    ...scene,
    contentBasis: saved.contentBasis,
    versionReference: { kind: 'preview-save', requestId: 'request-1' }
  }
}

async function registeredScene(
  options: {
    script?: string
    assets?: readonly { relativePath: string; bytes: Uint8Array }[]
  } = {}
): Promise<{
  root: string
  userDirectory: string
  projectRoot: string
}> {
  const root = await mkdtemp(join(tmpdir(), 'scene-export-'))
  roots.push(root)
  const userDirectory = join(root, 'user')
  const projectRoot = join(root, 'project')
  await mkdir(userDirectory)
  await mkdir(join(projectRoot, '.opengalgame/canvases', encodeStorageKey(scene.sceneId)), {
    recursive: true
  })
  await mkdir(join(projectRoot, 'game/scene'), { recursive: true })
  await mkdir(join(projectRoot, 'game/figure'), { recursive: true })
  await mkdir(join(projectRoot, 'game/background'), { recursive: true })
  await writeFile(
    join(projectRoot, '.opengalgame/project.json'),
    JSON.stringify({
      id: scene.projectId,
      name: '导出工程',
      synopsis: ''
    })
  )
  await writeFile(
    join(projectRoot, '.opengalgame/manifest.json'),
    JSON.stringify({
      formatVersion: 2,
      projectId: scene.projectId,
      operationId: 'op-register'
    })
  )
  await writeFile(join(projectRoot, 'game/scene/start.txt'), options.script ?? script)
  for (const asset of options.assets ?? []) {
    const target = join(projectRoot, asset.relativePath)
    await mkdir(join(target, '..'), { recursive: true })
    await writeFile(target, asset.bytes)
  }
  await writeFile(join(projectRoot, 'game/figure/hero.png'), Uint8Array.of(1, 2, 3))
  await writeFile(join(projectRoot, 'game/background/room.webp'), Uint8Array.of(9, 8, 7))
  await writeFile(
    join(projectRoot, '.opengalgame/scene-locks.json'),
    JSON.stringify({
      scenes: [{ sceneId: scene.sceneId, lockState: 'unlocked' }]
    })
  )
  await writeFile(
    join(projectRoot, '.opengalgame/canvases', encodeStorageKey(scene.sceneId), 'canvas.json'),
    '{}'
  )
  await writeProjectRegistrations(userDirectory, [
    { id: scene.projectId, directory: projectRoot, operationId: 'op-register' }
  ])
  execFileSync('git', ['init'], { cwd: projectRoot })
  await createProjectVersioningGateways(userDirectory).transactions.initializeBaseline({
    projectId: scene.projectId,
    initialPaths: [
      'game/scene/start.txt',
      ...(options.assets ?? []).map((asset) => asset.relativePath),
      'game/figure/hero.png',
      'game/background/room.webp',
      '.opengalgame/scene-locks.json',
      '.opengalgame/project.json'
    ]
  })
  return { root, userDirectory, projectRoot }
}
