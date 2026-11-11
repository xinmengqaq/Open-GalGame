import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { createRequire } from 'node:module'
import * as fs from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

import type { SavedSceneExportSource } from '@application/scene-export/ports/SceneExportSourceGateway'
import type {
  WindowsScenePackageResult,
  WindowsScenePackager
} from '@application/scene-export/ports/WindowsScenePackager'
import {
  sceneExportErrorMessages,
  SceneExportErrorCodes
} from '@domain/scene-export/errors/SceneExportErrorCodes'
import { assertRelativePath, resolveContained } from '@infrastructure/git/containedPath'
import { RegisteredSceneLocationGatewayImpl } from '@infrastructure/scenes/RegisteredSceneLocationGatewayImpl'

import { resolveSceneAssetReference } from '@infrastructure/webgal/assetPath'

const require = createRequire(import.meta.url)
const execFileAsync = promisify(execFile)

// 打包输入和输出中的 .asar 必须作为真实文件处理，不走 Electron 的虚拟目录。
const exportFs: typeof fs = process.versions.electron ? require('original-fs') : fs
const { cp, lstat, mkdir, readFile, rm, stat, writeFile } = exportFs.promises

/**
 * Terre 4.6.5 官方 Windows 发布包。
 * 只使用其中的 Electron 模板和 WebGAL 模板，发布包不进入源码。
 * 来源：https://github.com/OpenWebGAL/WebGAL_Terre/releases/download/4.6.5/WebGAL_Terre_Windows_4.6.5.zip
 * 许可：MPL-2.0。校验值来自 GitHub Release API 的 sha256 digest。
 */
const TERRE_WINDOWS_RELEASE = {
  fileName: 'WebGAL_Terre_Windows_4.6.5.zip',
  bytes: 174_584_841,
  sha256: '3100b12e01f9ec9fabaf893b1f5caf8c18c5ca36f537b3c8055ea48462d57c9d',
  api: 'https://api.github.com/repos/OpenWebGAL/WebGAL_Terre/releases/assets/586152709',
  electronTemplate: 'release/assets/templates/WebGAL_Electron_Template',
  webgalTemplate: 'release/assets/templates/WebGAL_Template'
} as const

const SINGLE_SCENE_CONFIG = `Game_name:当前场景;
Game_key:;
Title_img:;
Title_bgm:;
`

type AsarPackager = {
  createPackageWithOptions(
    source: string,
    destination: string,
    options: { unpack: string }
  ): Promise<unknown>
}

/**
 * 按 Terre `exportGame(gameName, 'electron-windows')` 组装当前已保存场景。
 * 官方模板未校验通过时返回不可用，不调用 electron-builder，也不生成假可执行文件。
 */
export class TerreWindowsScenePackager implements WindowsScenePackager {
  constructor(private readonly userDirectory = path.join(homedir(), '.opengalgame')) {}

  async packageWindowsScene(source: SavedSceneExportSource): Promise<WindowsScenePackageResult> {
    if (process.platform !== 'win32') return unavailable()
    const release = await locateOfficialRelease(this.userDirectory)
    if (!release) return unavailable()
    const directoryName = sceneDirectoryName(source)
    const outputRoot = path.join(this.userDirectory, 'exports', directoryName)
    const staging = path.join(tmpdir(), `terre-export-${directoryName}`)
    try {
      await rm(staging, { recursive: true, force: true })
      await mkdir(staging, { recursive: true })
      await assembleOfficialWindowsExport(release, staging, source, this.userDirectory)
      await mkdir(path.dirname(outputRoot), { recursive: true })
      await rm(outputRoot, { recursive: true, force: true })
      await cp(staging, outputRoot, { recursive: true })
      const executable = await stat(path.join(outputRoot, 'WebGAL.exe'))
      if (!executable.isFile() || executable.size <= 0) return failed()
      return {
        status: 'succeeded',
        artifact: {
          executableName: 'WebGAL.exe',
          directoryName,
          directoryPath: outputRoot,
          bytes: executable.size,
          containsFixedEngine: true,
          entryRelativePath: source.entryRelativePath,
          contentBasis: source.contentBasis,
          versionReference: source.versionReference
        }
      }
    } catch {
      await rm(outputRoot, { recursive: true, force: true }).catch(() => undefined)
      return failed()
    } finally {
      await rm(staging, { recursive: true, force: true }).catch(() => undefined)
    }
  }
}

function unavailable(): WindowsScenePackageResult {
  return {
    status: 'unavailable',
    reason: 'windowsPackagerUnavailable',
    message: sceneExportErrorMessages[SceneExportErrorCodes.windowsPackagerUnavailable]
  }
}

function failed(): WindowsScenePackageResult {
  return {
    status: 'failed',
    message: sceneExportErrorMessages[SceneExportErrorCodes.exportFailed]
  }
}

function sceneDirectoryName(source: SavedSceneExportSource): string {
  const digest = createHash('sha256')
    .update(
      `${source.scene.projectId}\0${source.scene.sceneId}\0${source.contentBasis.digest}\0${source.versionReference.requestId}`
    )
    .digest('hex')
  return `scene-${digest.slice(0, 16)}`
}

async function locateOfficialRelease(userDirectory: string): Promise<string | undefined> {
  const configured = process.env.OPENGALGAME_TERRE_WINDOWS_RELEASE
  if (configured !== undefined) return (await verifiedRelease(configured)) ? configured : undefined
  const localAppData = process.env.LOCALAPPDATA
  const candidates = [
    path.join(userDirectory, 'templates', 'terre-4.6.5', TERRE_WINDOWS_RELEASE.fileName),
    localAppData
      ? path.join(
          localAppData,
          'opengalgame',
          'templates',
          'terre-4.6.5',
          TERRE_WINDOWS_RELEASE.fileName
        )
      : undefined
  ]
  for (const candidate of candidates) {
    if (candidate && (await verifiedRelease(candidate))) return candidate
  }
  const downloaded = path.join(
    userDirectory,
    'templates',
    'terre-4.6.5',
    TERRE_WINDOWS_RELEASE.fileName
  )
  if (!(await downloadOfficialRelease(downloaded))) return undefined
  return downloaded
}

async function verifiedRelease(candidate: string): Promise<boolean> {
  try {
    const info = await stat(candidate)
    if (!info.isFile() || info.size !== TERRE_WINDOWS_RELEASE.bytes) return false
    const hash = createHash('sha256')
    hash.update(await readFile(candidate))
    return hash.digest('hex') === TERRE_WINDOWS_RELEASE.sha256
  } catch {
    return false
  }
}

async function downloadOfficialRelease(destination: string): Promise<boolean> {
  const partial = `${destination}.partial`
  try {
    await mkdir(path.dirname(destination), { recursive: true })
    const response = await fetch(TERRE_WINDOWS_RELEASE.api, {
      headers: {
        Accept: 'application/octet-stream',
        'User-Agent': 'opengalgame-scene-export'
      },
      redirect: 'follow'
    })
    if (!response.ok || !response.body) return false
    await writeFile(partial, Buffer.from(await response.arrayBuffer()))
    if (!(await verifiedRelease(partial))) {
      await rm(partial, { force: true })
      return false
    }
    await rm(destination, { force: true })
    await cp(partial, destination)
    await rm(partial, { force: true })
    return true
  } catch {
    await rm(partial, { force: true }).catch(() => undefined)
    return false
  }
}

async function assembleOfficialWindowsExport(
  releaseZip: string,
  exportDir: string,
  source: SavedSceneExportSource,
  userDirectory: string
): Promise<void> {
  const extracted = path.join(exportDir, '.release')
  await extractOfficialTemplates(releaseZip, extracted)
  const electronTemplate = path.join(
    extracted,
    ...TERRE_WINDOWS_RELEASE.electronTemplate.split('/')
  )
  const webgalTemplate = path.join(extracted, ...TERRE_WINDOWS_RELEASE.webgalTemplate.split('/'))
  await assertOrdinaryDirectory(electronTemplate, 'WebGAL.exe')
  await assertOrdinaryDirectory(webgalTemplate, path.join('game', 'config.txt'))
  await cp(electronTemplate, exportDir, { recursive: true })
  const appDir = path.join(exportDir, 'resources', 'app')
  const publicDir = path.join(appDir, 'public')
  await cp(webgalTemplate, publicDir, { recursive: true })
  await renameManifest(path.join(publicDir, 'manifest.json'))
  await rm(path.join(publicDir, 'webgal-serviceworker.js'), { force: true })
  await writeSingleScene(publicDir, source, userDirectory)
  await maximizeCopiedTemplateWindow(path.join(appDir, 'main.js'))
  await writeCopiedTemplateBaseStyle(publicDir)
  const asar = require(require.resolve('@electron/asar')) as AsarPackager
  await asar.createPackageWithOptions(appDir, path.join(exportDir, 'resources', 'app.asar'), {
    unpack: '**/node_modules/steamworks.js/dist/**'
  })
  await rm(appDir, { recursive: true, force: true })
  await rm(extracted, { recursive: true, force: true })
  const packed = await stat(path.join(exportDir, 'resources', 'app.asar'))
  if (!packed.isFile() || packed.size <= 0) throw new Error('empty asar')
}

/**
 * 只改复制出的模板。官方发布包不改。
 * 固定内容尺寸删除后，窗口按桌面可用区域最大化，系统标题栏仍保留。
 */
export async function maximizeCopiedTemplateWindow(mainPath: string): Promise<void> {
  const current = await readFile(mainPath, 'utf8')
  if (
    !current.includes('width: 1600') ||
    !current.includes('height: 900') ||
    !current.includes('useContentSize: true')
  ) {
    throw new Error('template window unchanged')
  }
  const next = current
    .replace(/\s*width:\s*1600,?/u, '')
    .replace(/\s*height:\s*900,?/u, '')
    .replace(/\s*useContentSize:\s*true,?/u, '')
    .replace(
      'win.loadFile',
      "const area = require('electron').screen.getPrimaryDisplay().workArea; win.setBounds(area); win.maximize();\n  win.loadFile"
    )
  if (
    next === current ||
    next.includes('width: 1600') ||
    next.includes('height: 900') ||
    next.includes('useContentSize')
  ) {
    throw new Error('template window unchanged')
  }
  await writeFile(mainPath, next)
}

/**
 * 只改复制出的模板样式。WebGAL 按 2560×1440 设计尺寸由引擎 resize() 缩放居中，
 * 因此不得覆盖 #root/.App/canvas 的尺寸；保留该文件只为黑色 letterbox 底色，
 * 同时避免引擎请求 userStyleSheet.css 时 404。
 */
export async function writeCopiedTemplateBaseStyle(publicDir: string): Promise<void> {
  const stylePath = path.join(publicDir, 'game', 'userStyleSheet.css')
  await writeFile(stylePath, 'html,body{background:#000}\n')
}

async function extractOfficialTemplates(releaseZip: string, destination: string): Promise<void> {
  await mkdir(destination, { recursive: true })
  const prefixes = [TERRE_WINDOWS_RELEASE.electronTemplate, TERRE_WINDOWS_RELEASE.webgalTemplate]
  await execFileAsync('tar', ['-xf', releaseZip, '-C', destination, ...prefixes], {
    windowsHide: true
  })
}

async function assertOrdinaryDirectory(root: string, marker: string): Promise<void> {
  const stats = await lstat(root)
  if (!stats.isDirectory() || stats.isSymbolicLink()) throw new Error('template rejected')
  const markerStats = await stat(path.join(root, marker))
  if (!markerStats.isFile() || markerStats.size <= 0) throw new Error('template marker missing')
}

async function renameManifest(manifestPath: string): Promise<void> {
  const current = await readFile(manifestPath, 'utf8')
  const next = current.replaceAll('WebGAL DEMO', '当前场景').replaceAll('WebGAL', '当前场景')
  if (next === current || next.includes('WebGAL')) throw new Error('manifest unchanged')
  await writeFile(manifestPath, next)
}

export async function writeSingleScene(
  publicDir: string,
  source: SavedSceneExportSource,
  userDirectory: string
): Promise<void> {
  const gameDir = path.join(publicDir, 'game')
  const templateSupport = path.join(publicDir, '.template-game')
  await cp(gameDir, templateSupport, { recursive: true })
  await rm(gameDir, { recursive: true, force: true })
  await mkdir(gameDir, { recursive: true })
  for (const name of ['animation', 'template', 'tex', 'userStyleSheet.css']) {
    await cp(path.join(templateSupport, name), path.join(gameDir, name), { recursive: true })
  }
  await rm(templateSupport, { recursive: true, force: true })
  const entry = assertRelativePath(source.entryRelativePath)
  if (!entry.startsWith('game/')) throw new Error('entry outside game')
  const entryInsideGame = entry.slice('game/'.length)
  await mkdir(path.dirname(path.join(gameDir, entryInsideGame)), { recursive: true })
  await writeFile(path.join(gameDir, 'config.txt'), SINGLE_SCENE_CONFIG)
  await writeFile(path.join(gameDir, entryInsideGame), source.sceneText)
  if (source.referencedAssets.length === 0) return
  const location = await new RegisteredSceneLocationGatewayImpl(
    userDirectory
  ).resolveRegisteredScene(source.scene)
  for (const asset of source.referencedAssets) {
    const sourcePath = assertRelativePath(asset.sourcePath)
    const packagePath = assertRelativePath(asset.packagePath)
    const resolved = resolveSceneAssetReference({
      sourcePath: packagePath,
      runtimeDirectory: packagePath.startsWith('game/')
        ? (packagePath.slice('game/'.length).split('/')[0] ?? '')
        : ''
    })
    if (resolved.canonicalPath !== packagePath) throw new Error('unresolved asset')
    const contained = await resolveContained(location.projectRoot, sourcePath)
    const sourceBytes = await readFile(contained)
    const destination = path.join(gameDir, packagePath.slice('game/'.length))
    await mkdir(path.dirname(destination), { recursive: true })
    await writeFile(destination, sourceBytes)
  }
}
