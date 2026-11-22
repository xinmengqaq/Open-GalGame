import { createHash, randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import type { Stats } from 'node:fs'
import { createRequire } from 'node:module'
import * as fs from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

import type { SavedSceneExportSource } from '@application/scene-export/ports/SceneExportSourceGateway'
import type { SceneExportDestination } from '@application/scene-export/ports/SceneExportDestinationGateway'
import {
  sameSceneExportVersion,
  sceneExportVersionKey
} from '@application/scene-export/services/sceneExportVersion'
import type {
  WindowsScenePackageResult,
  WindowsScenePackager
} from '@application/scene-export/ports/WindowsScenePackager'
import type { SceneExportVersionReference, WindowsScenePackageVO } from '@application/scene-export/vo/SceneExportVO'
import { AppException } from '@common/errors/AppException'
import { errorFacts } from '@common/errors/errorFacts'
import type { LoggerGateway } from '@common/logging/LoggerGateway'
import {
  sceneExportErrorMessages,
  SceneExportErrorCodes
} from '@domain/scene-export/errors/SceneExportErrorCodes'
import { assertRelativePath, resolveContained } from '@infrastructure/git/containedPath'
import { RegisteredSceneLocationGatewayImpl } from '@infrastructure/scenes/RegisteredSceneLocationGatewayImpl'
import { resolveSceneAssetReference } from '@infrastructure/webgal/assetPath'
import {
  DEFAULT_GAME_CONFIG,
  DEFAULT_USER_STYLE_SHEET
} from '@infrastructure/webgal/runtime/defaultWebgalAssets'

import {
  EXPORT_BACKUP_PREFIX,
  EXPORT_MARKER_FILE,
  EXPORT_STAGING_PREFIX
} from './exportDestinationPaths'
import { validateParentDirectory } from './LocalSceneExportDestinationGateway'

const require = createRequire(import.meta.url)
const execFileAsync = promisify(execFile)

const exportFs: typeof fs = process.versions.electron ? require('original-fs') : fs
const { cp, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } =
  exportFs.promises

/**
 * Terre 4.6.5 官方 Windows 发布包。
 * 来源：https://github.com/OpenWebGAL/WebGAL_Terre/releases/download/4.6.5/WebGAL_Terre_Windows_4.6.5.zip
 * 许可：MPL-2.0。
 */
const TERRE_WINDOWS_RELEASE = {
  fileName: 'WebGAL_Terre_Windows_4.6.5.zip',
  bytes: 174_584_841,
  sha256: '3100b12e01f9ec9fabaf893b1f5caf8c18c5ca36f537b3c8055ea48462d57c9d',
  api: 'https://api.github.com/repos/OpenWebGAL/WebGAL_Terre/releases/assets/586152709',
  electronTemplate: 'release/assets/templates/WebGAL_Electron_Template',
  webgalTemplate: 'release/assets/templates/WebGAL_Template'
} as const

type AsarPackager = {
  createPackageWithOptions(
    source: string,
    destination: string,
    options: { unpack: string }
  ): Promise<unknown>
}

type PackagingStage = 'preparing-staging' | 'assembling' | 'publishing' | 'verifying'
type ExistingExportState = 'absent' | 'valid' | 'repairable' | 'foreign' | 'conflict'

/** 打包时实际写入产物的素材来源摘要，用来判定正式引用素材是否变化。 */
export type SourceAssetDigest = {
  readonly sourcePath: string
  readonly sha256: string
}

/** 产物根内由本次导出分发的文件；相对路径统一使用 `/` 分隔。 */
export type ExportProductFile = {
  readonly relativePath: string
  readonly bytes: number
  readonly sha256: string
}

interface ExportMarker {
  readonly formatVersion: 3
  readonly projectId: string
  readonly sceneId: string
  readonly contentDigest: string
  readonly versionReference: SceneExportVersionReference
  readonly directoryName: string
  readonly files: readonly ExportProductFile[]
  readonly sourceAssets: readonly SourceAssetDigest[]
}

interface DirectoryIdentity {
  readonly dev: number
  readonly ino: number
}

const SAFE_DIAGNOSTIC_NAME = /^[A-Z][A-Za-z0-9_.]{0,63}$/u

/**
 * 按 Terre `exportGame(gameName, 'electron-windows')` 组装当前已保存场景。
 * 官方模板未校验通过时返回不可用，不调用 electron-builder，也不生成假可执行文件。
 * 产物发布到目的地父目录下的 `scene-<版本摘要>`；父目录永不被删除。
 */
export class TerreWindowsScenePackager implements WindowsScenePackager {
  constructor(
    private readonly logger: LoggerGateway,
    private readonly userDirectory = path.join(homedir(), '.opengalgame'),
    private readonly protectedRoots: readonly string[] = []
  ) {}

  async packageWindowsScene(
    source: SavedSceneExportSource,
    destination: SceneExportDestination
  ): Promise<WindowsScenePackageResult> {
    if (process.platform !== 'win32') return unavailable()
    const directoryName = sceneExportDirectoryName(source)
    let stage: PackagingStage = 'preparing-staging'
    try {
      const parentDirectory = await this.authorizedParentDirectory(destination, true)
      const parentIdentity = await directoryIdentity(parentDirectory)
      const outputRoot = path.join(parentDirectory, directoryName)
      const currentAssets = await currentSourceAssets(source, destination.projectRoot)
      const existing = await inspectExistingExport(
        outputRoot,
        source,
        directoryName,
        currentAssets
      )
      if (existing === 'valid') return await succeededArtifact(outputRoot, source, directoryName)
      if (existing === 'foreign') throw foreignFilesError()
      if (existing === 'conflict') throw destinationError(SceneExportErrorCodes.destinationConflict)
      const release = await locateOfficialRelease(this.userDirectory)
      if (!release) return unavailable()
      const staging = await mkdtemp(path.join(parentDirectory, EXPORT_STAGING_PREFIX))
      const stagingIdentity = await directoryIdentity(staging)
      try {
        stage = 'assembling'
        const sourceAssets = await assembleOfficialWindowsExport(
          release,
          staging,
          source,
          this.userDirectory
        )
        stage = 'publishing'
        const recheckedParent = await this.authorizedParentDirectory(destination, false)
        const recheckedIdentity = await directoryIdentity(recheckedParent)
        if (
          !samePath(recheckedParent, parentDirectory) ||
          !sameDirectoryIdentity(parentIdentity, recheckedIdentity)
        ) {
          throw destinationError(
            SceneExportErrorCodes.destinationRejected,
            '导出位置在打包期间发生变化，请重新选择'
          )
        }
        const verifiedAssets = await assertSourceUnchanged(
          source,
          destination.projectRoot,
          sourceAssets
        )
        await publishWindowsExport(
          staging,
          parentDirectory,
          directoryName,
          source,
          sourceAssets
        )
        stage = 'verifying'
        if (
          (await inspectExistingExport(
            outputRoot,
            source,
            directoryName,
            verifiedAssets
          )) !== 'valid'
        ) {
          throw new Error('exported artifact verification failed')
        }
      } finally {
        await cleanupStaging(staging, parentDirectory, parentIdentity, stagingIdentity)
      }
      return await succeededArtifact(outputRoot, source, directoryName)
    } catch (error) {
      if (error instanceof AppException) throw error
      this.recordPackagingFailure(stage, error)
      return failed()
    }
  }

  async verifyWindowsScene(
    source: SavedSceneExportSource,
    destination: SceneExportDestination,
    artifact: WindowsScenePackageVO
  ): Promise<boolean> {
    if (
      artifact.executableName !== 'WebGAL.exe' ||
      artifact.bytes <= 0 ||
      !artifact.containsFixedEngine ||
      artifact.entryRelativePath !== source.entryRelativePath ||
      artifact.contentBasis.digest !== source.contentBasis.digest ||
      !sameSceneExportVersion(artifact.versionReference, source.versionReference)
    ) {
      return false
    }
    const directoryName = sceneExportDirectoryName(source)
    if (artifact.directoryName !== directoryName) return false
    let parentDirectory: string
    try {
      parentDirectory = await this.authorizedParentDirectory(destination, false)
    } catch {
      return false
    }
    const expected = path.join(parentDirectory, directoryName)
    if (!samePath(artifact.directoryPath, expected)) return false
    try {
      const executable = await stat(path.join(expected, 'WebGAL.exe'))
      if (!executable.isFile() || executable.size !== artifact.bytes) return false
      const currentAssets = await currentSourceAssets(source, destination.projectRoot)
      return (
        (await inspectExistingExport(expected, source, directoryName, currentAssets)) === 'valid'
      )
    } catch {
      return false
    }
  }

  /**
   * 发布或复用前复核目的地：必须是授权时的真实普通目录，workspace 只能是当前工程
   * 的 `exports`，显式选择仍不得落入工程权威子树、用户状态或受保护根。
   */
  private async authorizedParentDirectory(
    destination: SceneExportDestination,
    createWorkspace: boolean
  ): Promise<string> {
    if (!path.isAbsolute(destination.parentDirectory)) throw destinationError()
    if (destination.kind === 'workspace') {
      if (createWorkspace) {
        try {
          await mkdir(destination.parentDirectory, { recursive: true })
        } catch {
          throw destinationError(
            SceneExportErrorCodes.destinationRejected,
            '无法创建工程导出目录，请检查工程文件权限'
          )
        }
      }
    }
    let resolved: string
    try {
      resolved = await validateParentDirectory(
        destination.parentDirectory,
        destination.projectRoot,
        this.userDirectory,
        this.protectedRoots,
        { allowProjectRootChild: destination.kind === 'workspace' }
      )
    } catch (error) {
      if (error instanceof AppException) throw error
      throw destinationError(
        SceneExportErrorCodes.destinationRejected,
        '所选文件夹不可用，请重新选择'
      )
    }
    if (!samePath(resolved, destination.parentDirectory)) {
      throw destinationError(
        SceneExportErrorCodes.destinationRejected,
        '导出位置的真实路径已变化，请重新选择'
      )
    }
    if (destination.kind === 'workspace') {
      const expected = path.join(destination.projectRoot, 'exports')
      const expectedRealPath = await realpathOrResolve(expected)
      if (!samePath(resolved, expectedRealPath)) {
        throw destinationError(
          SceneExportErrorCodes.destinationRejected,
          '工程导出目录不属于当前工程，请重新打开工程'
        )
      }
    }
    return resolved
  }

  private recordPackagingFailure(stage: PackagingStage, error: unknown): void {
    try {
      const facts = errorFacts(error)
      const failure = packagingFailureOf(error)
      const causeNames = facts.causeNames.filter((name) => SAFE_DIAGNOSTIC_NAME.test(name))
      this.logger.error('Windows 场景导出打包失败', {
        stage,
        errorCode: SceneExportErrorCodes.exportFailed,
        category: failure.category,
        ...(facts.errorName !== undefined && SAFE_DIAGNOSTIC_NAME.test(facts.errorName)
          ? { errorName: facts.errorName }
          : {}),
        ...(causeNames.length > 0 ? { causeNames: causeNames.join(',') } : {}),
        ...(failure.codes.length > 0 ? { causeCodes: failure.codes.join(',') } : {}),
        ...(facts.statuses.length > 0 ? { statuses: facts.statuses.join(',') } : {})
      })
    } catch {
      // 日志出口失败不改变已经形成的失败结果；不删除父目录或归属不明产物。
    }
  }
}

/**
 * 校验 staging 产物并发布到 `<父目录>/<scene-目录名>`。
 * 调用方必须先通过目的地授权与真实路径复核；本函数只在给定父目录内操作。
 * 同身份且完整时复用；同身份不完整或摘要已变化时用备份目录原子替换；无归属同名目录失败。
 * 并发发布者抢到有效产物时返回复用，并清理本次替换产生的备份。
 * @returns 发布或复用结果，供调用方继续核对最终产物。
 */
export async function publishWindowsExport(
  stagingDirectory: string,
  destinationParent: string,
  directoryName: string,
  source: SavedSceneExportSource,
  sourceAssets: readonly SourceAssetDigest[] = [],
  renameFile: (from: string, to: string) => Promise<void> = rename
): Promise<'published' | 'reused'> {
  const finalDirectory = path.join(destinationParent, directoryName)
  const staged = await inspectStagedExport(stagingDirectory)
  if (!staged) throw new Error('staged export incomplete')
  if (source.referencedAssets.length > 0 && sourceAssets.length === 0) {
    throw new Error('source asset digests missing')
  }
  const files = await writeExportMarker(stagingDirectory, source, directoryName, sourceAssets)
  const expected = expectedProductPaths(files)
  let backup: string | null = null
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const existing = await inspectExistingExport(
      finalDirectory,
      source,
      directoryName,
      sourceAssets,
      expected
    )
    if (existing === 'valid') {
      await discardBackup(backup, expected)
      return 'reused'
    }
    if (existing === 'foreign') throw foreignFilesError()
    if (existing === 'conflict') {
      throw destinationError(SceneExportErrorCodes.destinationConflict)
    }
    if (existing === 'absent') break
    backup = path.join(destinationParent, `${EXPORT_BACKUP_PREFIX}${randomUUID()}`)
    try {
      await renameFile(finalDirectory, backup)
      break
    } catch (error) {
      await discardBackup(backup, expected)
      backup = null
      const raced = await inspectExistingExport(
        finalDirectory,
        source,
        directoryName,
        sourceAssets,
        expected
      )
      if (raced === 'valid') return 'reused'
      if (raced === 'foreign') throw foreignFilesError()
      if (raced === 'conflict') {
        throw destinationError(SceneExportErrorCodes.destinationConflict)
      }
      if (attempt === 2) throw error
    }
  }
  try {
    await renameFile(stagingDirectory, finalDirectory)
  } catch (error) {
    const raced = await inspectExistingExport(
      finalDirectory,
      source,
      directoryName,
      sourceAssets,
      expected
    )
    if (raced === 'valid') {
      await discardBackup(backup, expected)
      return 'reused'
    }
    if (backup !== null) {
      const restored = await renameFile(backup, finalDirectory).then(
        () => true,
        () => false
      )
      if (restored) backup = null
      else await discardBackup(backup, expected)
    }
    throw error
  }
  await discardBackup(backup, expected)
  return 'published'
}

async function discardBackup(
  backup: string | null,
  expected: ReadonlySet<string>
): Promise<void> {
  if (backup === null) return
  try {
    const info = await lstat(backup)
    if (!info.isDirectory() || info.isSymbolicLink()) return
    const entries = await collectProductEntries(backup)
    if (hasExtraEntries(entries, expected)) return
    await rm(backup, { recursive: true, force: true })
  } catch {
    // 备份已不存在或无法确认内容时保留，不冒险删除。
  }
}

async function inspectStagedExport(stagingDirectory: string): Promise<boolean> {
  try {
    const info = await lstat(stagingDirectory)
    if (!info.isDirectory() || info.isSymbolicLink()) return false
    const executable = await stat(path.join(stagingDirectory, 'WebGAL.exe'))
    const asar = await stat(path.join(stagingDirectory, 'resources', 'app.asar'))
    return executable.isFile() && executable.size > 0 && asar.isFile() && asar.size > 0
  } catch {
    return false
  }
}

/**
 * 既有产物判定：不存在、完整且归属本版本、本场景可修复的不完整产物、含用户文件的
 * 待替换产物，或无归属冲突。
 * 归属只认与本次 project/scene/内容摘要/版本引用一致的标记文件；完整要求标记内的
 * 全部产物文件存在且字节、大小一致，并核对打包时实际使用的素材摘要和当前来源。
 * 产物完整时允许目录里有用户新增文件并直接复用；产物不完整时若存在清单外文件，
 * 返回 foreign 拒绝替换，避免删除用户无关内容。
 */
async function inspectExistingExport(
  directory: string,
  source: SavedSceneExportSource,
  directoryName: string,
  currentAssets: readonly SourceAssetDigest[],
  baseline?: ReadonlySet<string>
): Promise<ExistingExportState> {
  let info: Stats
  try {
    info = await lstat(directory)
  } catch (error) {
    if (isMissing(error)) return 'absent'
    throw error
  }
  if (!info.isDirectory() || info.isSymbolicLink()) return 'conflict'
  let marker: unknown
  try {
    marker = JSON.parse(await readFile(path.join(directory, EXPORT_MARKER_FILE), 'utf8'))
  } catch {
    return 'conflict'
  }
  if (!markerIdentityMatches(marker, source, directoryName)) return 'conflict'
  const stored = marker as Partial<ExportMarker>
  if (stored.formatVersion !== 3) {
    if (baseline === undefined) return 'repairable'
    const entries = await collectProductEntries(directory)
    return hasExtraEntries(entries, baseline) ? 'foreign' : 'repairable'
  }
  const files = parseExportManifest(stored.files)
  if (files === null) {
    if (baseline === undefined) return 'repairable'
    const entries = await collectProductEntries(directory)
    return hasExtraEntries(entries, baseline) ? 'foreign' : 'repairable'
  }
  const expected = baseline ?? expectedProductPaths(files)
  if (!sourceAssetsMatch(stored.sourceAssets, currentAssets)) {
    const entries = await collectProductEntries(directory)
    return hasExtraEntries(entries, expected) ? 'foreign' : 'repairable'
  }
  const verified = await verifyExportManifest(directory, files)
  if (verified.valid) return 'valid'
  return hasExtraEntries(verified.entries, expected) ? 'foreign' : 'repairable'
}

async function writeExportMarker(
  directory: string,
  source: SavedSceneExportSource,
  directoryName: string,
  sourceAssets: readonly SourceAssetDigest[]
): Promise<readonly ExportProductFile[]> {
  const files = await buildExportManifest(directory)
  const marker: ExportMarker = {
    formatVersion: 3,
    projectId: source.scene.projectId,
    sceneId: source.scene.sceneId,
    contentDigest: source.contentBasis.digest,
    versionReference: source.versionReference,
    directoryName,
    files,
    sourceAssets: normalizeSourceAssets(sourceAssets)
  }
  await writeFile(
    path.join(directory, EXPORT_MARKER_FILE),
    `${JSON.stringify(marker, null, 2)}\n`,
    'utf8'
  )
  return files
}

function markerIdentityMatches(
  value: unknown,
  source: SavedSceneExportSource,
  directoryName: string
): boolean {
  if (typeof value !== 'object' || value === null) return false
  const marker = value as Record<string, unknown>
  if (marker.formatVersion !== 1 && marker.formatVersion !== 2 && marker.formatVersion !== 3) {
    return false
  }
  if (typeof marker.versionReference !== 'object' || marker.versionReference === null) {
    return false
  }
  return (
    marker.projectId === source.scene.projectId &&
    marker.sceneId === source.scene.sceneId &&
    marker.contentDigest === source.contentBasis.digest &&
    marker.directoryName === directoryName &&
    sameSceneExportVersion(
      marker.versionReference as SceneExportVersionReference,
      source.versionReference
    )
  )
}

function sourceAssetsMatch(
  value: unknown,
  current: readonly SourceAssetDigest[]
): boolean {
  if (!Array.isArray(value)) return false
  const stored = new Map<string, string>()
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null) return false
    const asset = entry as Partial<SourceAssetDigest>
    if (typeof asset.sourcePath !== 'string' || typeof asset.sha256 !== 'string') return false
    if (stored.has(asset.sourcePath)) return false
    stored.set(asset.sourcePath, asset.sha256)
  }
  if (stored.size !== current.length) return false
  return current.every((asset) => stored.get(asset.sourcePath) === asset.sha256)
}

type ProductEntryKind = 'file' | 'directory' | 'symlink' | 'other'

/** 枚举产物根内所有条目（不含归属标记），只读不跟随链接。 */
async function collectProductEntries(
  directory: string
): Promise<Map<string, ProductEntryKind>> {
  const entries = new Map<string, ProductEntryKind>()
  const walk = async (current: string, prefix: string): Promise<void> => {
    const children = await readdir(current, { withFileTypes: true })
    for (const child of children) {
      const relativePath = prefix === '' ? child.name : `${prefix}/${child.name}`
      if (relativePath === EXPORT_MARKER_FILE) continue
      const fullPath = path.join(current, child.name)
      const info = await lstat(fullPath)
      if (info.isSymbolicLink()) {
        entries.set(relativePath, 'symlink')
      } else if (info.isDirectory()) {
        entries.set(relativePath, 'directory')
        await walk(fullPath, relativePath)
      } else if (info.isFile()) {
        entries.set(relativePath, 'file')
      } else {
        entries.set(relativePath, 'other')
      }
    }
  }
  await walk(directory, '')
  return entries
}

/** 从 staging 实际内容生成完整分发表单；链接、特殊文件和缺少固定入口都拒绝。 */
async function buildExportManifest(
  directory: string
): Promise<readonly ExportProductFile[]> {
  const entries = await collectProductEntries(directory)
  const files: ExportProductFile[] = []
  for (const [relativePath, kind] of entries) {
    if (kind === 'directory') continue
    if (kind !== 'file') throw new Error('export contains unsupported entry')
    const fullPath = path.join(directory, ...relativePath.split('/'))
    const info = await lstat(fullPath)
    if (!info.isFile() || info.isSymbolicLink()) throw new Error('export file changed')
    files.push({
      relativePath,
      bytes: info.size,
      sha256: await sha256File(fullPath)
    })
  }
  const paths = new Set(files.map((file) => file.relativePath))
  if (!paths.has('WebGAL.exe') || !paths.has('resources/app.asar')) {
    throw new Error('export manifest incomplete')
  }
  return files.sort((first, second) =>
    first.relativePath < second.relativePath
      ? -1
      : first.relativePath > second.relativePath
        ? 1
        : 0
  )
}

function parseExportManifest(value: unknown): readonly ExportProductFile[] | null {
  if (!Array.isArray(value) || value.length === 0) return null
  const files: ExportProductFile[] = []
  const seen = new Set<string>()
  for (const item of value) {
    if (typeof item !== 'object' || item === null) return null
    const entry = item as Partial<ExportProductFile>
    if (
      typeof entry.relativePath !== 'string' ||
      !manifestPathIsSafe(entry.relativePath) ||
      typeof entry.bytes !== 'number' ||
      !Number.isInteger(entry.bytes) ||
      entry.bytes < 0 ||
      typeof entry.sha256 !== 'string' ||
      !/^[0-9a-f]{64}$/u.test(entry.sha256) ||
      seen.has(entry.relativePath)
    ) {
      return null
    }
    seen.add(entry.relativePath)
    files.push(entry as ExportProductFile)
  }
  if (!seen.has('WebGAL.exe') || !seen.has('resources/app.asar')) return null
  return files
}

function manifestPathIsSafe(value: string): boolean {
  if (
    value.length === 0 ||
    value.length > 1024 ||
    value.includes('\0') ||
    value.includes('\\') ||
    value.startsWith('/') ||
    /^[A-Za-z]:/u.test(value)
  ) {
    return false
  }
  return value
    .split('/')
    .every((part) => part !== '' && part !== '.' && part !== '..')
}

/** 清单文件路径及其全部父目录都视为产物命名空间。 */
function expectedProductPaths(files: readonly ExportProductFile[]): Set<string> {
  const paths = new Set<string>()
  for (const file of files) {
    const parts = file.relativePath.split('/')
    for (let index = 1; index <= parts.length; index += 1) {
      paths.add(parts.slice(0, index).join('/'))
    }
  }
  return paths
}

async function verifyExportManifest(
  directory: string,
  files: readonly ExportProductFile[]
): Promise<{
  readonly valid: boolean
  readonly entries: Map<string, ProductEntryKind>
}> {
  const entries = await collectProductEntries(directory)
  let valid = true
  for (const file of files) {
    if (!valid) break
    if (entries.get(file.relativePath) !== 'file') {
      valid = false
      continue
    }
    try {
      const fullPath = path.join(directory, ...file.relativePath.split('/'))
      const info = await lstat(fullPath)
      if (!info.isFile() || info.isSymbolicLink() || info.size !== file.bytes) {
        valid = false
        continue
      }
      if ((await sha256File(fullPath)) !== file.sha256) valid = false
    } catch {
      valid = false
    }
  }
  return { valid, entries }
}

function hasExtraEntries(
  entries: ReadonlyMap<string, ProductEntryKind>,
  expected: ReadonlySet<string>
): boolean {
  for (const relativePath of entries.keys()) {
    if (!expected.has(relativePath)) return true
  }
  return false
}

function foreignFilesError(): AppException {
  return destinationError(
    SceneExportErrorCodes.destinationConflict,
    '导出目录含有无法归属的文件，已停止替换；请先移走这些文件再导出'
  )
}

function normalizeSourceAssets(
  assets: readonly SourceAssetDigest[]
): readonly SourceAssetDigest[] {
  const byPath = new Map<string, string>()
  for (const asset of assets) byPath.set(asset.sourcePath, asset.sha256)
  return [...byPath]
    .sort(([first], [second]) => (first < second ? -1 : first > second ? 1 : 0))
    .map(([sourcePath, sha256]) => ({ sourcePath, sha256 }))
}

async function sha256File(filePath: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of exportFs.createReadStream(filePath)) {
    hash.update(chunk)
  }
  return hash.digest('hex')
}

/** 从正式工程读取当前引用素材摘要；缺失或越界会失败，调用方不得把旧产物当作有效缓存。 */
async function currentSourceAssets(
  source: SavedSceneExportSource,
  projectRoot: string
): Promise<readonly SourceAssetDigest[]> {
  const digests: SourceAssetDigest[] = []
  const seen = new Set<string>()
  for (const asset of source.referencedAssets) {
    const sourcePath = assertRelativePath(asset.sourcePath)
    if (seen.has(sourcePath)) continue
    seen.add(sourcePath)
    const contained = await resolveContained(projectRoot, sourcePath)
    digests.push({ sourcePath, sha256: await sha256File(contained) })
  }
  return normalizeSourceAssets(digests)
}

/**
 * 长时间组装后、发布 rename 紧前重新读取正式场景和引用素材。
 * 与组装时实际复制的摘要不一致就拒绝发布，不能用组装时摘要冒充当前内容。
 * @returns 重新读取的当前素材摘要，供发布后再核对最终产物。
 */
export async function assertSourceUnchanged(
  source: SavedSceneExportSource,
  projectRoot: string,
  packagedAssets: readonly SourceAssetDigest[]
): Promise<readonly SourceAssetDigest[]> {
  const entryPath = await resolveContained(projectRoot, source.entryRelativePath)
  if ((await sha256File(entryPath)) !== source.entrySha256) {
    throw new Error('scene changed during packaging')
  }
  const currentAssets = await currentSourceAssets(source, projectRoot)
  if (!sourceAssetDigestsEqual(currentAssets, packagedAssets)) {
    throw new Error('source assets changed during packaging')
  }
  return currentAssets
}

function sourceAssetDigestsEqual(
  left: readonly SourceAssetDigest[],
  right: readonly SourceAssetDigest[]
): boolean {
  if (left.length !== right.length) return false
  const expected = new Map(left.map((asset) => [asset.sourcePath, asset.sha256]))
  return right.every((asset) => expected.get(asset.sourcePath) === asset.sha256)
}

async function directoryIdentity(directory: string): Promise<DirectoryIdentity> {
  const info = await lstat(directory)
  return { dev: info.dev, ino: info.ino }
}

function sameDirectoryIdentity(
  first: DirectoryIdentity,
  second: DirectoryIdentity
): boolean {
  return first.dev === second.dev && first.ino === second.ino
}

/**
 * 只清理本次在授权父目录内创建的 staging。父目录或 staging 已不是原目录时跳过，
 * 避免在路径被替换后删除错误位置。
 */
export async function cleanupStaging(
  stagingDirectory: string,
  expectedParent: string,
  parentIdentity: { readonly dev: number; readonly ino: number },
  stagingIdentity: { readonly dev: number; readonly ino: number }
): Promise<void> {
  try {
    const parent = await lstat(expectedParent)
    if (
      !parent.isDirectory() ||
      parent.isSymbolicLink() ||
      !sameDirectoryIdentity(parent, parentIdentity)
    ) {
      return
    }
    const staging = await lstat(stagingDirectory)
    if (
      !staging.isDirectory() ||
      staging.isSymbolicLink() ||
      !sameDirectoryIdentity(staging, stagingIdentity)
    ) {
      return
    }
    await rm(stagingDirectory, { recursive: true, force: true })
  } catch {
    // 父目录或 staging 缺失/变化时宁可不清理，也不删除错误位置。
  }
}

function samePath(first: string, second: string): boolean {
  const left = path.resolve(first)
  const right = path.resolve(second)
  return process.platform === 'win32'
    ? left.toLowerCase() === right.toLowerCase()
    : left === right
}

async function realpathOrResolve(target: string): Promise<string> {
  try {
    return await exportFs.promises.realpath(target)
  } catch {
    return path.resolve(target)
  }
}

async function succeededArtifact(
  outputRoot: string,
  source: SavedSceneExportSource,
  directoryName: string
): Promise<WindowsScenePackageResult> {
  const executable = await stat(path.join(outputRoot, 'WebGAL.exe'))
  const asar = await stat(path.join(outputRoot, 'resources', 'app.asar'))
  if (
    !executable.isFile() ||
    executable.size <= 0 ||
    !asar.isFile() ||
    asar.size <= 0
  ) {
    throw new Error('exported artifact incomplete')
  }
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

function destinationError(
  code: (typeof SceneExportErrorCodes)[keyof typeof SceneExportErrorCodes] =
    SceneExportErrorCodes.destinationRejected,
  message = sceneExportErrorMessages[code]
): AppException {
  return new AppException({ code, msg: message })
}

function isMissing(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as NodeJS.ErrnoException).code === 'ENOENT'
  )
}

function packagingFailureOf(error: unknown): {
  readonly category:
    | 'systemTarMissing'
    | 'systemTarRemotePath'
    | 'pathMissing'
    | 'diskFull'
    | 'templateExtractionFailed'
    | 'packagingFailed'
  readonly codes: readonly string[]
} {
  const codes = new Set<string>()
  const seen = new Set<unknown>()
  let current: unknown = error
  while (
    current !== undefined &&
    current !== null &&
    typeof current === 'object' &&
    !seen.has(current)
  ) {
    seen.add(current)
    if ('code' in current) {
      const code: unknown = current.code
      if (typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,31}$/u.test(code)) codes.add(code)
      else if (typeof code === 'number' && Number.isFinite(code)) codes.add(String(code))
    }
    current = 'cause' in current ? current.cause : undefined
  }
  const codesList = [...codes]
  const stderr = diagnosticStderr(error)
  const systemTar = isSystemTarFailure(error)
  if (codes.has('ENOSPC') || /No space left on device/iu.test(stderr)) {
    return { category: 'diskFull', codes: codesList }
  }
  if (codes.has('ENOENT')) {
    return { category: systemTar ? 'systemTarMissing' : 'pathMissing', codes: codesList }
  }
  if (systemTar && /(?:Cannot connect to|resolve failed)/iu.test(stderr)) {
    return { category: 'systemTarRemotePath', codes: codesList }
  }
  if (systemTar) return { category: 'templateExtractionFailed', codes: codesList }
  return { category: 'packagingFailed', codes: codesList }
}

function diagnosticStderr(error: unknown): string {
  if (typeof error !== 'object' || error === null || !('stderr' in error)) return ''
  return typeof error.stderr === 'string' ? error.stderr.slice(0, 4096) : ''
}

function isSystemTarFailure(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false
  const values: unknown[] = []
  if ('cmd' in error) values.push(error.cmd)
  if ('path' in error) values.push(error.path)
  if ('syscall' in error) values.push(error.syscall)
  return values.some(
    (value) =>
      typeof value === 'string' &&
      /(?:^|[\\/\s])tar(?:\.exe)?(?:[\s"']|$)/iu.test(value)
  )
}

export function sceneExportDirectoryName(source: SavedSceneExportSource): string {
  const digest = createHash('sha256')
    .update(
      `${source.scene.projectId}\0${source.scene.sceneId}\0${source.contentBasis.digest}\0${sceneExportVersionKey(source.versionReference)}`
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
): Promise<readonly SourceAssetDigest[]> {
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
  const sourceAssets = await writeSingleScene(publicDir, source, userDirectory)
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
  return sourceAssets
}

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

export async function writeCopiedTemplateBaseStyle(publicDir: string): Promise<void> {
  const stylePath = path.join(publicDir, 'game', 'userStyleSheet.css')
  await writeFile(stylePath, DEFAULT_USER_STYLE_SHEET)
}

async function extractOfficialTemplates(releaseZip: string, destination: string): Promise<void> {
  await mkdir(destination, { recursive: true })
  const prefixes = [TERRE_WINDOWS_RELEASE.electronTemplate, TERRE_WINDOWS_RELEASE.webgalTemplate]
  await execFileAsync(systemTarExecutable(), ['-xf', releaseZip, '-C', destination, ...prefixes], {
    windowsHide: true
  })
}

function systemTarExecutable(): string {
  if (process.platform !== 'win32') return 'tar'
  const systemRoot = process.env.SystemRoot
  if (!systemRoot) throw new Error('SystemRoot unavailable')
  return path.join(systemRoot, 'System32', 'tar.exe')
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
): Promise<readonly SourceAssetDigest[]> {
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
  await writeFile(path.join(gameDir, 'config.txt'), DEFAULT_GAME_CONFIG)
  await writeFile(path.join(gameDir, entryInsideGame), source.sceneText)
  if (source.referencedAssets.length === 0) return []
  const location = await new RegisteredSceneLocationGatewayImpl(
    userDirectory
  ).resolveRegisteredScene(source.scene)
  const assetDigests = new Map<string, string>()
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
    assetDigests.set(sourcePath, createHash('sha256').update(sourceBytes).digest('hex'))
    const destination = path.join(gameDir, packagePath.slice('game/'.length))
    await mkdir(path.dirname(destination), { recursive: true })
    await writeFile(destination, sourceBytes)
  }
  return normalizeSourceAssets(
    [...assetDigests].map(([sourcePath, sha256]) => ({ sourcePath, sha256 }))
  )
}
