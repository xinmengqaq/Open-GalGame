import { execFile, execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { build } from 'esbuild'
import { afterEach, describe, expect, it } from 'vitest'

import { ManageProjectVersioning } from '@application/project-versioning/services/impl/ManageProjectVersioning'
import { ExportSavedScene } from '@application/scene-export/services/impl/ExportSavedScene'
import type { WindowsScenePackager } from '@application/scene-export/ports/WindowsScenePackager'
import { createProjectVersioningGateways } from '@infrastructure/project-versioning/createProjectVersioningGateways'
import { encodeStorageKey } from '@infrastructure/project-files/projectFilePaths'
import { writeProjectRegistrations } from '@infrastructure/projects/projectRegistrations'
import { LocalSceneExportDestinationGateway } from '@infrastructure/scene-export/LocalSceneExportDestinationGateway'
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
import type { LoggerGateway } from '@common/logging/LoggerGateway'
import { SceneExportErrorCodes } from '@domain/scene-export/errors/SceneExportErrorCodes'

const roots: string[] = []
const scene = { projectId: 'project-1', sceneId: 'scene-1' }
const script = '小明:已保存的一句 -next;\r\nchangeBg:room.webp;\r\nchangeFigure:hero.png;\r\n'
const committedScript = '小明:生成提交导出的一句 -next;\r\nchangeBg:room.webp;\r\nchangeFigure:hero.png;\r\n'
const logger: LoggerGateway = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined
}
const unsaved = {
  ...scene,
  contentBasis: { digest: 'a'.repeat(64), parserVersion: '4.6.5', engineVersion: '4.6.5' },
  versionReference: { kind: 'preview-save' as const, requestId: 'missing-save' }
}

// 成品启动验收默认跳过：只有显式开启时才运行一次，避免日常回归打开导出的游戏。
const launchAcceptance = process.env.OPENGALGAME_SCENE_EXPORT_LAUNCH_ACCEPTANCE === '1'

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
        new TerreWindowsScenePackager(logger, world.userDirectory)
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

  it('Electron 主进程导出到工程 exports，复用完整产物且不改正式内容', async () => {
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
    const headBefore = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: world.projectRoot,
      encoding: 'utf8'
    }).trim()
    const sceneBefore = await readFile(join(world.projectRoot, 'game/scene/start.txt'))
    const previous = process.env.OPENGALGAME_TERRE_WINDOWS_RELEASE
    process.env.OPENGALGAME_TERRE_WINDOWS_RELEASE = release
    try {
      const packager = await electronPackager(world, release)
      const service = exporter(world.userDirectory, packager)
      await expect(service.exportSavedScene(saved)).resolves.toMatchObject({ status: 'succeeded' })
      const result = await service.exportSavedScene(saved)
      expect(result.status).toBe('succeeded')
      expect(packager.packageCalls()).toBe(1)
      if (result.status !== 'succeeded') return
      expect(result.artifact.executableName).toBe('WebGAL.exe')
      expect(result.artifact.bytes).toBeGreaterThan(0)
      expect(result.artifact.directoryName).toMatch(/^scene-[a-f0-9]{16}$/)
      expect(result.artifact.entryRelativePath).toBe('game/scene/start.txt')
      const output = join(
        world.projectRoot,
        'exports',
        result.artifact.directoryName
      )
      expect(result.artifact.directoryPath).toBe(output)
      await expect(stat(join(world.userDirectory, 'exports'))).rejects.toThrow()
      expect(
        execFileSync('git', ['rev-parse', 'HEAD'], {
          cwd: world.projectRoot,
          encoding: 'utf8'
        }).trim()
      ).toBe(headBefore)
      expect(await readFile(join(world.projectRoot, 'game/scene/start.txt'))).toEqual(sceneBefore)
      for (const directory of ['game', 'assets', '.opengalgame']) {
        const entries = await readdir(join(world.projectRoot, directory), {
          withFileTypes: true
        }).catch(() => [])
        expect(
          entries.filter((entry) => entry.isDirectory() && entry.name.startsWith('scene-'))
        ).toEqual([])
      }
      const marker = JSON.parse(
        await readFile(join(output, '.scene-export.json'), 'utf8')
      ) as {
        projectId: string
        sceneId: string
        directoryName: string
        files: readonly { relativePath: string; bytes: number; sha256: string }[]
      }
      expect(marker).toMatchObject({
        projectId: scene.projectId,
        sceneId: scene.sceneId,
        directoryName: result.artifact.directoryName
      })
      const manifest = new Map(marker.files.map((file) => [file.relativePath, file]))
      for (const relative of [
        'WebGAL.exe',
        'resources/app.asar',
        'resources.pak',
        'ffmpeg.dll',
        'locales/zh-CN.pak'
      ]) {
        expect(manifest.has(relative)).toBe(true)
      }
      const pak = manifest.get('resources.pak')!
      expect(pak.bytes).toBe((await stat(join(output, 'resources.pak'))).size)
      expect(pak.sha256).toBe(
        createHash('sha256')
          .update(await readFile(join(output, 'resources.pak')))
          .digest('hex')
      )
      const packed = await readFile(join(output, 'resources', 'app.asar'))
      expect(packed.byteLength).toBeGreaterThan(0)
      const listing = execFileSync(
        process.execPath,
        [
          '-e',
          "const asar=require('@electron/asar'); const root=process.argv[1]; const dest=require('node:os').tmpdir()+'/terre-check'; asar.extractAll(root+'/resources/app.asar', dest); const fs=require('node:fs'); const base=dest+'/public/game/'; console.log(fs.readFileSync(base+'scene/start.txt','utf8')); console.log(fs.readFileSync(base+'figure/hero.png').toString('hex')); console.log(fs.readFileSync(base+'background/room.webp').toString('hex')); console.log(fs.readFileSync(dest+'/public/webgal-engine.json','utf8')); console.log('__CONFIG__'+fs.readFileSync(base+'config.txt','utf8')); console.log('__USER_STYLE__'+fs.readFileSync(base+'userStyleSheet.css','utf8')); console.log('__MAIN__'+fs.readFileSync(dest+'/main.js','utf8'));",
          output
        ],
        { cwd: join(process.cwd(), 'node_modules', '@electron', 'asar'), encoding: 'utf8' }
      )
      expect(listing).toContain('导出前保存的一句')
      expect(listing).toContain('010203')
      expect(listing).toContain('"version": "4.6.5"')
      expect(listing).toContain('changeBg:')
      expect(listing).not.toContain(world.projectRoot)
      expect(listing).toMatch(
        /__CONFIG__Game_name:当前场景;\nGame_key:;\nTitle_img:;\nTitle_bgm:;\n/
      )
      expect(listing).toContain('__USER_STYLE__html,body{background:#000}\n')
      expect(listing).not.toMatch(/#root\s*\{|\.App\s*\{|#pixiCont|canvas\s*\{[^}]*width/i)
      expect(listing).toMatch(/__MAIN__[\s\S]*setBounds\(area\);\s*win\.maximize\(\)/)
      expect(listing).not.toMatch(/__MAIN__[\s\S]*width:\s*1600/)
    } finally {
      if (previous === undefined) delete process.env.OPENGALGAME_TERRE_WINDOWS_RELEASE
      else process.env.OPENGALGAME_TERRE_WINDOWS_RELEASE = previous
    }
  }, 40_000)

  /**
   * 隔离成品启动验收，默认跳过；显式设置
   * `OPENGALGAME_SCENE_EXPORT_LAUNCH_ACCEPTANCE=1` 后单独运行（可配合 `-t`）。
   * 只启动本次隔离导出产物一次，用 `--version` 让 Electron 立即正常退出；
   * 不调用 taskkill、不结束用户进程、不反复重启，也不触碰用户工作台。
   */
  it.skipIf(!launchAcceptance)(
    '隔离成品单实例正常退出，不结束用户进程',
    async () => {
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
        const service = exporter(world.userDirectory, await electronPackager(world, release))
        const result = await service.exportSavedScene(saved)
        expect(result.status).toBe('succeeded')
        if (result.status !== 'succeeded') return
        const output = join(world.projectRoot, 'exports', result.artifact.directoryName)
        expect(result.artifact.directoryPath).toBe(output)
        const marker = JSON.parse(
          await readFile(join(output, '.scene-export.json'), 'utf8')
        ) as { directoryName: string }
        expect(marker.directoryName).toBe(result.artifact.directoryName)

        const profile = await mkdtemp(join(tmpdir(), 'scene-export-launch-profile-'))
        try {
          const env = { ...process.env }
          delete env.ELECTRON_RUN_AS_NODE
          const child = spawnSync(
            join(output, 'WebGAL.exe'),
            ['--version', `--user-data-dir=${profile}`],
            {
              cwd: output,
              env,
              windowsHide: true,
              timeout: 20_000,
              encoding: 'utf8'
            }
          )
          expect(child.error).toBeUndefined()
          expect(child.signal).toBeNull()
          expect(child.status).toBe(0)
        } finally {
          await rm(profile, { recursive: true, force: true })
        }
      } finally {
        if (previous === undefined) delete process.env.OPENGALGAME_TERRE_WINDOWS_RELEASE
        else process.env.OPENGALGAME_TERRE_WINDOWS_RELEASE = previous
      }
    },
    120_000
  )

  it('同一版本导出到两个父目录时两边产物存在且字节一致', async () => {
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
    const firstParent = join(world.root, 'destination-a')
    const secondParent = join(world.root, 'destination-b')
    await mkdir(firstParent)
    await mkdir(secondParent)
    const previous = process.env.OPENGALGAME_TERRE_WINDOWS_RELEASE
    process.env.OPENGALGAME_TERRE_WINDOWS_RELEASE = release
    try {
      const packager = await electronPackager(world, release)
      const firstGateway = new LocalSceneExportDestinationGateway({
        userDirectory: world.userDirectory,
        chooseDirectory: async () => firstParent
      })
      const secondGateway = new LocalSceneExportDestinationGateway({
        userDirectory: world.userDirectory,
        chooseDirectory: async () => secondParent
      })
      const firstChoice = await firstGateway.chooseParentDirectory(scene)
      const secondChoice = await secondGateway.chooseParentDirectory(scene)
      if (firstChoice.status !== 'selected' || secondChoice.status !== 'selected') {
        throw new Error('没有选中导出父目录')
      }
      const firstRequest = {
        ...saved,
        destination: {
          kind: 'selected' as const,
          selectionId: firstChoice.selectionId
        }
      }
      const secondRequest = {
        ...saved,
        destination: {
          kind: 'selected' as const,
          selectionId: secondChoice.selectionId
        }
      }
      expect(JSON.stringify(firstRequest)).not.toContain(firstParent)
      const first = await exporter(
        world.userDirectory,
        packager,
        undefined,
        firstGateway
      ).exportSavedScene(firstRequest)
      const second = await exporter(
        world.userDirectory,
        packager,
        undefined,
        secondGateway
      ).exportSavedScene(secondRequest)
      expect(first.status).toBe('succeeded')
      expect(second.status).toBe('succeeded')
      if (first.status !== 'succeeded' || second.status !== 'succeeded') return
      expect(first.artifact.directoryName).toBe(second.artifact.directoryName)
      const firstOutput = join(firstParent, first.artifact.directoryName)
      const secondOutput = join(secondParent, second.artifact.directoryName)
      expect(first.artifact.directoryPath).toBe(firstOutput)
      expect(second.artifact.directoryPath).toBe(secondOutput)
      for (const relative of ['WebGAL.exe', join('resources', 'app.asar')]) {
        const [firstBytes, secondBytes] = await Promise.all([
          readFile(join(firstOutput, relative)),
          readFile(join(secondOutput, relative))
        ])
        expect(createHash('sha256').update(firstBytes).digest('hex')).toBe(
          createHash('sha256').update(secondBytes).digest('hex')
        )
      }
    } finally {
      if (previous === undefined) delete process.env.OPENGALGAME_TERRE_WINDOWS_RELEASE
      else process.env.OPENGALGAME_TERRE_WINDOWS_RELEASE = previous
    }
  }, 90_000)

  it('生成提交在没有预览保存时也能通过真实 Electron 打包，并把提交内容写入 ASAR', async () => {
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
    const versioningService = versioning(world.userDirectory)
    const callerOperationId = 'generation-export-1'
    const targets = [{ kind: 'scene', id: scene.sceneId }]
    const changePaths = ['game/scene/start.txt']
    const prepared = await versioningService.prepareOperation({
      projectId: scene.projectId,
      sourceModule: 'scene-generation',
      targets,
      changePaths,
      watchedPaths: []
    })
    await versioningService.bindCallerOperation({
      projectId: scene.projectId,
      sourceModule: 'scene-generation',
      callerOperationId,
      operationId: prepared.operationId,
      targets,
      changePaths,
      watchedPaths: []
    })
    const committed = await versioningService.commitOperation(
      {
        projectId: scene.projectId,
        operationId: prepared.operationId,
        callerOperationId,
        baselineRef: prepared.baselineRef,
        input: {
          kind: 'files',
          changes: [
            {
              relativePath: 'game/scene/start.txt',
              action: 'modify',
              content: { kind: 'bytes', bytes: new TextEncoder().encode(committedScript) }
            }
          ]
        },
        saveMode: 'manual',
        contentSource: 'ai',
        title: '确认场景生成',
        summary: '已确认的场景脚本进入作品'
      },
      () => undefined
    )
    await expect(
      stat(join(world.projectRoot, '.git/opengalgame/scene-preview-saves'))
    ).rejects.toThrow()
    const reader = new LocalScenePreviewSourceGateway(
      new RegisteredSceneLocationGatewayImpl(world.userDirectory),
      new SceneSourceReaderGatewayImpl(),
      new SceneScriptParserGatewayImpl(),
      new SceneAssetReferenceGatewayImpl()
    )
    const preview = await reader.readScenePreviewSource(scene)
    const previous = process.env.OPENGALGAME_TERRE_WINDOWS_RELEASE
    process.env.OPENGALGAME_TERRE_WINDOWS_RELEASE = release
    try {
      const service = exporter(world.userDirectory, await electronPackager(world, release))
      const request = {
        ...scene,
        contentBasis: preview.contentBasis,
        versionReference: {
          kind: 'generation-commit' as const,
          operationId: callerOperationId,
          commitId: committed.revisionRef
        }
      }
      const result = await service.exportSavedScene(request)
      expect(result.status).toBe('succeeded')
      if (result.status !== 'succeeded') return
      const output = join(world.projectRoot, 'exports', result.artifact.directoryName)
      expect(result.artifact.versionReference).toEqual(request.versionReference)
      expect(result.artifact.entryRelativePath).toBe('game/scene/start.txt')
      expect((await stat(join(output, 'WebGAL.exe'))).size).toBeGreaterThan(0)
      const listing = execFileSync(
        process.execPath,
        [
          '-e',
          "const asar=require('@electron/asar'); const dest=require('node:os').tmpdir()+'/terre-check-generation'; asar.extractAll(process.argv[1]+'/resources/app.asar', dest); const fs=require('node:fs'); const base=dest+'/public/game/'; console.log(fs.readFileSync(base+'scene/start.txt','utf8')); console.log(fs.readFileSync(base+'figure/hero.png').toString('hex'));",
          output
        ],
        { cwd: join(process.cwd(), 'node_modules', '@electron', 'asar'), encoding: 'utf8' }
      )
      expect(listing).toContain('生成提交导出的一句')
      expect(listing).not.toContain('已保存的一句')
      expect(listing).toContain('010203')
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
    const service = exporter(world.userDirectory, new TerreWindowsScenePackager(logger))
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
    expect(await readFile(join(publicDir, 'game/config.txt'), 'utf8')).toBe(
      'Game_name:当前场景;\nGame_key:;\nTitle_img:;\nTitle_bgm:;\n'
    )
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
  packager: ConstructorParameters<typeof ExportSavedScene>[0]['packager'],
  chooseDirectory: () => Promise<string | null> = async () => null,
  destinationGateway?: ConstructorParameters<typeof ExportSavedScene>[0]['destinations']
): ExportSavedScene {
  const locations = new RegisteredSceneLocationGatewayImpl(userDirectory)
  const sources = new SceneSourceReaderGatewayImpl()
  const parser = new SceneScriptParserGatewayImpl()
  return new ExportSavedScene({
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
    destinations:
      destinationGateway ??
      new LocalSceneExportDestinationGateway({
        userDirectory,
        chooseDirectory
      }),
    packager
  })
}

/**
 * 用真实 Electron 主进程运行 Terre 打包器。
 * 测试工程挂到仓库 node_modules 的 junction，只读复用已安装依赖。
 */
async function electronPackager(
  world: { root: string; userDirectory: string },
  release: string
): Promise<WindowsScenePackager & { readonly packageCalls: () => number }> {
  const electronMain = join(world.root, 'export-main.mjs')
  const sourceFile = join(world.root, 'export-source.json')
  const resultFile = join(world.root, 'export-result.json')
  await symlink(join(process.cwd(), 'node_modules'), join(world.root, 'node_modules'), 'junction')
  await build({
    stdin: {
      contents: `
        import { app } from 'electron'
        import { readFile, writeFile } from 'node:fs/promises'
        import { TerreWindowsScenePackager } from './src/infrastructure/scene-export/TerreWindowsScenePackager'
        async function main() {
          await app.whenReady()
          const payload = JSON.parse(await readFile(process.argv[2], 'utf8'))
          const logger = { debug() {}, info() {}, warn() {}, error() {} }
          const result = await new TerreWindowsScenePackager(logger, process.argv[4]).packageWindowsScene(payload.source, payload.destination)
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
  process.env.OPENGALGAME_TERRE_WINDOWS_RELEASE = release
  const verifier = new TerreWindowsScenePackager(logger, world.userDirectory)
  let packaged = 0
  return {
    async packageWindowsScene(source, destination) {
      packaged += 1
      await writeFile(sourceFile, JSON.stringify({ source, destination }))
      const env = { ...process.env }
      delete env.ELECTRON_RUN_AS_NODE
      await promisify(execFile)(
        createRequire(import.meta.url)('electron') as string,
        [electronMain, sourceFile, resultFile, world.userDirectory],
        { env, timeout: 30_000, windowsHide: true }
      )
      return JSON.parse(await readFile(resultFile, 'utf8'))
    },
    verifyWindowsScene(source, destination, artifact) {
      return verifier.verifyWindowsScene(source, destination, artifact)
    },
    packageCalls: () => packaged
  }
}

function versioning(userDirectory: string): ManageProjectVersioning {
  return new ManageProjectVersioning({
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
