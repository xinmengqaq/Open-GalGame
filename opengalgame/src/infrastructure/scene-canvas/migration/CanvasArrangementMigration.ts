import { randomUUID } from 'node:crypto'
import { lstat, mkdir, open, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'

import { enqueueWorkWrite } from '@infrastructure/git/transaction/workWriteBoundary'
import {
  digestBytes,
  digestVersionParts
} from '@infrastructure/project-files/public/projectFileStorage'
import {
  decodeStrictUtf8,
  readStableProjectFile,
  StableFileReadError
} from '@infrastructure/storage/StableProjectFileReader'

import {
  SCENE_CANVAS_ARRANGEMENT_FORMAT_VERSION,
  sceneCanvasArrangementDocumentSchema
} from '../documents/SceneCanvasArrangementDocument'
import { arrangementPath } from '../sceneCanvasPaths'
import {
  assertCanvasMigrationManifest,
  CANVAS_MIGRATION_TOOL_VERSION,
  createCanvasMigrationManifest,
  type CanvasMigrationManifest
} from './canvasArrangementBackupManifest'
import {
  planCanvasArrangementMigration,
  type CanvasArrangementMigrationPlan,
  type CanvasMigrationDefaultedField,
  type CanvasMigrationNormalizedField
} from './canvasArrangementMigrationPlan'
import {
  isPathInside,
  pathKey,
  realPathOfPossiblyMissing,
  resolveInsideRealRoot
} from './canvasMigrationPaths'

export type CanvasMigrationTrigger = 'open' | 'save' | 'inspect' | 'generation' | 'cli'

export type CanvasMigrationFailureStage =
  'resolve' | 'parse' | 'validate' | 'backup' | 'write' | 'verify'

export type CanvasMigrationSkipReason =
  'missing' | 'invalid' | 'unsupported' | 'damaged' | 'identity' | 'changed'

export type CanvasArrangementMigrationOutcome = {
  status: 'migrated' | 'current' | 'skipped' | 'failed'
  sourceVersion: 3 | 4 | 5 | null
  targetVersion: 5
  batchId: string | null
  manifestPath: string | null
  reportPath: string | null
  preserved: string[]
  defaulted: CanvasMigrationDefaultedField[]
  normalized: CanvasMigrationNormalizedField[]
  unsupported: string[]
  reason?: CanvasMigrationSkipReason
  failure?: { stage: CanvasMigrationFailureStage; code?: string }
  recovered?: boolean
}

export type CanvasArrangementMigrationInput = {
  projectId: string
  directory: string
  sceneId: string
  canvasId: string
  trigger: CanvasMigrationTrigger
}

type CanvasArrangementMigrationReport = {
  formatVersion: 1
  kind: 'canvas-arrangement-migration-report'
  batchId: string
  toolVersion: string
  createdAt: string
  trigger: CanvasMigrationTrigger
  projectId: string
  sceneId: string
  canvasId: string
  sourceVersion: 3 | 4
  targetVersion: 5
  sourceSha256: string
  writtenSha256: string
  preserved: string[]
  defaulted: CanvasMigrationDefaultedField[]
  normalized: CanvasMigrationNormalizedField[]
  unsupported: string[]
}

type SourceRead = {
  absolutePath: string
  bytes: Buffer
  digest: string
  modifiedAt: string
}

const TARGET_VERSION = SCENE_CANVAS_ARRANGEMENT_FORMAT_VERSION
const BATCH_DIGEST_LABEL = 'canvas-arrangement-migration-v1'

export class CanvasArrangementMigration {
  private readonly backupRoot: string
  private readonly now: () => Date

  constructor(options: { backupRoot: string; now?: () => Date }) {
    this.backupRoot = options.backupRoot
    this.now = options.now ?? (() => new Date())
  }

  async ensureCurrent(
    input: CanvasArrangementMigrationInput
  ): Promise<CanvasArrangementMigrationOutcome> {
    if (input.sceneId.trim() === '' || input.canvasId.trim() === '') {
      return emptyOutcome('skipped', 'invalid')
    }
    let relativePath: string
    try {
      relativePath = arrangementPath(input.sceneId, input.canvasId)
    } catch {
      return emptyOutcome('skipped', 'invalid')
    }
    try {
      return await enqueueWorkWrite(input.directory, () => this.migrate(input, relativePath))
    } catch (error) {
      return failedOutcome('resolve', error)
    }
  }

  private async migrate(
    input: CanvasArrangementMigrationInput,
    relativePath: string
  ): Promise<CanvasArrangementMigrationOutcome> {
    let projectDirectory: string
    try {
      projectDirectory = await realpath(input.directory)
    } catch (error) {
      return failedOutcome('resolve', error)
    }
    if (!isAbsolute(this.backupRoot)) return failedOutcome('backup')
    let backupRoot: string
    try {
      backupRoot = await realPathOfPossiblyMissing(this.backupRoot)
    } catch (error) {
      return failedOutcome('backup', error)
    }
    const source = await this.readSource(projectDirectory, relativePath)
    if ('status' in source) return source
    let value: unknown
    try {
      value = JSON.parse(decodeStrictUtf8(source.bytes))
    } catch {
      return emptyOutcome('skipped', 'damaged')
    }
    const plan = planCanvasArrangementMigration(
      value,
      { projectId: input.projectId, sceneId: input.sceneId, canvasId: input.canvasId },
      source.digest
    )
    if (!plan.ok) return outcomeForPlanFailure(plan)
    if (!(await projectIdentityMatches(projectDirectory, input.projectId))) {
      return emptyOutcome('skipped', 'identity', plan.sourceVersion)
    }
    if (isPathInside(projectDirectory, backupRoot) || isPathInside(backupRoot, projectDirectory)) {
      return failedOutcome('backup', undefined, plan.sourceVersion)
    }
    const batchId = digestVersionParts([
      BATCH_DIGEST_LABEL,
      projectDirectory,
      relativePath,
      source.digest
    ])
    const backupPath = `files/project-0/${relativePath}`
    let batchDir: string
    try {
      batchDir = await resolveInsideRealRoot(backupRoot, batchId)
    } catch (error) {
      return failedOutcome('backup', error, plan.sourceVersion)
    }
    const createdAt = this.now().toISOString()
    try {
      await this.ensureBatch({
        backupRoot,
        batchDir,
        batchId,
        backupPath,
        projectDirectory,
        originalPath: source.absolutePath,
        relativePath,
        source,
        createdAt
      })
    } catch (error) {
      return failedOutcome('backup', error)
    }
    const current = await this.readSource(projectDirectory, relativePath)
    if ('status' in current || current.digest !== source.digest) {
      return emptyOutcome('skipped', 'changed', plan.sourceVersion, batchId, batchDir)
    }
    const json = JSON.stringify(plan.document)
    const written = Buffer.from(json, 'utf8')
    const writtenDigest = digestBytes(written)
    try {
      await writeBytesAtomically(current.absolutePath, written)
    } catch (error) {
      return failedOutcome('write', error, plan.sourceVersion, batchId, batchDir)
    }
    const verificationError = await verifyWritten(current.absolutePath, plan, writtenDigest)
    if (verificationError !== null) {
      const recovered = await recoverOwnWrite(
        current.absolutePath,
        join(batchDir, ...backupPath.split('/')),
        writtenDigest,
        source.digest
      )
      return {
        ...failedOutcome('verify', verificationError, plan.sourceVersion, batchId, batchDir),
        recovered
      }
    }
    const reportPath = join(batchDir, 'report.json')
    try {
      await this.writeReport(reportPath, {
        formatVersion: 1,
        kind: 'canvas-arrangement-migration-report',
        batchId,
        toolVersion: CANVAS_MIGRATION_TOOL_VERSION,
        createdAt: this.now().toISOString(),
        trigger: input.trigger,
        projectId: input.projectId,
        sceneId: input.sceneId,
        canvasId: input.canvasId,
        sourceVersion: plan.sourceVersion,
        targetVersion: TARGET_VERSION,
        sourceSha256: source.digest,
        writtenSha256: writtenDigest,
        preserved: plan.preserved,
        defaulted: plan.defaulted,
        normalized: plan.normalized,
        unsupported: plan.unsupported
      })
    } catch {
      return migratedOutcome(plan, batchId, join(batchDir, 'manifest.json'), null)
    }
    return migratedOutcome(plan, batchId, join(batchDir, 'manifest.json'), reportPath)
  }

  private async readSource(
    projectDirectory: string,
    relativePath: string
  ): Promise<SourceRead | CanvasArrangementMigrationOutcome> {
    try {
      const { observation, bytes } = await readStableProjectFile(projectDirectory, relativePath)
      return {
        absolutePath: observation.absolutePath,
        bytes,
        digest: digestBytes(bytes),
        modifiedAt: (observation.stats?.mtime ?? new Date()).toISOString()
      }
    } catch (error) {
      if (error instanceof StableFileReadError && error.kind === 'missing') {
        return emptyOutcome('skipped', 'missing')
      }
      return failedOutcome('resolve', error)
    }
  }

  private async ensureBatch(input: {
    backupRoot: string
    batchDir: string
    batchId: string
    backupPath: string
    projectDirectory: string
    originalPath: string
    relativePath: string
    source: SourceRead
    createdAt: string
  }): Promise<CanvasMigrationManifest> {
    if (await pathExists(input.batchDir)) {
      return reuseBatch(input)
    }
    await mkdir(input.backupRoot, { recursive: true })
    const staging = join(input.backupRoot, `.staging-${input.batchId}-${randomUUID()}`)
    await mkdir(staging, { recursive: true })
    let stagingReal: string
    try {
      stagingReal = await realpath(staging)
      if (!isPathInside(input.backupRoot, stagingReal)) {
        throw new Error('暂存目录经链接越出备份根')
      }
    } catch (error) {
      await rm(staging, { recursive: true, force: true }).catch(() => undefined)
      throw error
    }
    try {
      const stagingBackup = await resolveInsideRealRoot(stagingReal, input.backupPath)
      await mkdir(dirname(stagingBackup), { recursive: true })
      await writeFile(stagingBackup, input.source.bytes, { flag: 'wx', flush: true })
      if (digestBytes(await readFile(stagingBackup)) !== input.source.digest) {
        throw new Error('备份摘要校验失败')
      }
      const manifest = createCanvasMigrationManifest({
        batchId: input.batchId,
        batchRoot: input.batchDir,
        projectRoot: input.projectDirectory,
        originalPath: input.originalPath,
        relativePath: input.relativePath,
        sizeBytes: input.source.bytes.byteLength,
        sha256: input.source.digest,
        modifiedAt: input.source.modifiedAt,
        backedUpAt: input.createdAt,
        createdAt: input.createdAt
      })
      await writeFile(
        join(stagingReal, 'manifest.json'),
        `${JSON.stringify(manifest, null, 2)}\n`,
        {
          flag: 'wx',
          flush: true
        }
      )
      await rename(stagingReal, input.batchDir)
      return manifest
    } catch (error) {
      await rm(staging, { recursive: true, force: true }).catch(() => undefined)
      await rm(stagingReal, { recursive: true, force: true }).catch(() => undefined)
      if (await pathExists(input.batchDir)) return reuseBatch(input)
      throw error
    }
  }

  private async writeReport(
    reportPath: string,
    report: CanvasArrangementMigrationReport
  ): Promise<void> {
    const temporary = join(dirname(reportPath), `.opengalgame-tmp-${randomUUID()}`)
    try {
      await writeFile(temporary, `${JSON.stringify(report, null, 2)}\n`, {
        flag: 'wx',
        flush: true
      })
      await rename(temporary, reportPath)
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined)
      throw error
    }
  }
}

async function reuseBatch(input: {
  batchDir: string
  batchId: string
  backupPath: string
  originalPath: string
  source: SourceRead
}): Promise<CanvasMigrationManifest> {
  const manifestPath = await resolveInsideRealRoot(input.batchDir, 'manifest.json')
  const raw = JSON.parse(await readFile(manifestPath, 'utf8'))
  const manifest = assertCanvasMigrationManifest(raw)
  if (manifest.batchId !== input.batchId) throw new Error('批次标识与目录不一致')
  if (pathKey(resolve(manifest.backupRoot)) !== pathKey(resolve(input.batchDir))) {
    throw new Error('批次备份根与 manifest 不一致')
  }
  const entry = manifest.entries.find(
    (item) => pathKey(resolve(item.originalPath)) === pathKey(resolve(input.originalPath))
  )
  if (
    entry === undefined ||
    entry.backupPath !== input.backupPath ||
    entry.sizeBytes !== input.source.bytes.byteLength ||
    entry.sha256 !== input.source.digest
  ) {
    throw new Error('同批次备份条目与当前来源不一致，拒绝覆盖')
  }
  const bytes = await readFile(await resolveInsideRealRoot(input.batchDir, input.backupPath))
  if (digestBytes(bytes) !== input.source.digest) {
    throw new Error('同批次备份字节与 manifest 不一致，拒绝覆盖')
  }
  return manifest
}

async function projectIdentityMatches(
  projectDirectory: string,
  projectId: string
): Promise<boolean> {
  try {
    const { bytes } = await readStableProjectFile(projectDirectory, '.opengalgame/manifest.json')
    const value = JSON.parse(decodeStrictUtf8(bytes)) as { projectId?: unknown }
    return value !== null && typeof value === 'object' && value.projectId === projectId
  } catch {
    return false
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

async function writeBytesAtomically(target: string, bytes: Uint8Array): Promise<void> {
  const temporary = join(dirname(target), `.opengalgame-tmp-${randomUUID()}`)
  const handle = await open(temporary, 'wx')
  try {
    try {
      await handle.writeFile(bytes)
      await handle.sync()
    } finally {
      await handle.close()
    }
    await rename(temporary, target)
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined)
    throw error
  }
}

async function verifyWritten(
  target: string,
  plan: Extract<CanvasArrangementMigrationPlan, { ok: true }>,
  writtenDigest: string
): Promise<Error | null> {
  try {
    const bytes = await readFile(target)
    if (digestBytes(bytes) !== writtenDigest) return new Error('写后摘要不一致')
    const parsed = sceneCanvasArrangementDocumentSchema.safeParse(
      JSON.parse(decodeStrictUtf8(bytes))
    )
    if (!parsed.success) return new Error('写后 schema 校验失败')
    if (JSON.stringify(parsed.data) !== JSON.stringify(plan.document)) {
      return new Error('写后字段与规划不一致')
    }
    return null
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error))
  }
}

async function recoverOwnWrite(
  target: string,
  backupFile: string,
  writtenDigest: string,
  sourceDigest: string
): Promise<boolean> {
  let current: Buffer
  try {
    current = await readFile(target)
  } catch {
    return false
  }
  if (digestBytes(current) !== writtenDigest) return false
  let backup: Buffer
  try {
    backup = await readFile(backupFile)
  } catch {
    return false
  }
  if (digestBytes(backup) !== sourceDigest) return false
  try {
    await writeBytesAtomically(target, backup)
    return digestBytes(await readFile(target)) === sourceDigest
  } catch {
    return false
  }
}

function outcomeForPlanFailure(
  plan: Extract<CanvasArrangementMigrationPlan, { ok: false }>
): CanvasArrangementMigrationOutcome {
  if (plan.reason === 'current') {
    return {
      ...emptyOutcome('current'),
      sourceVersion: 5
    }
  }
  return emptyOutcome(
    'skipped',
    plan.reason,
    plan.sourceVersion === 3 || plan.sourceVersion === 4 ? plan.sourceVersion : null
  )
}

function emptyOutcome(
  status: 'current' | 'skipped',
  reason?: CanvasMigrationSkipReason,
  sourceVersion: 3 | 4 | 5 | null = null,
  batchId: string | null = null,
  batchDir: string | null = null
): CanvasArrangementMigrationOutcome {
  return {
    status,
    ...(reason === undefined ? {} : { reason }),
    sourceVersion,
    targetVersion: TARGET_VERSION,
    batchId,
    manifestPath: batchDir === null ? null : join(batchDir, 'manifest.json'),
    reportPath: null,
    preserved: [],
    defaulted: [],
    normalized: [],
    unsupported: []
  }
}

function failedOutcome(
  stage: CanvasMigrationFailureStage,
  error?: unknown,
  sourceVersion: 3 | 4 | 5 | null = null,
  batchId: string | null = null,
  batchDir: string | null = null
): CanvasArrangementMigrationOutcome {
  const code = (error as NodeJS.ErrnoException | undefined)?.code
  return {
    status: 'failed',
    sourceVersion,
    targetVersion: TARGET_VERSION,
    batchId,
    manifestPath: batchDir === null ? null : join(batchDir, 'manifest.json'),
    reportPath: null,
    preserved: [],
    defaulted: [],
    normalized: [],
    unsupported: [],
    failure: {
      stage,
      ...(typeof code === 'string' ? { code } : {})
    }
  }
}

function migratedOutcome(
  plan: Extract<CanvasArrangementMigrationPlan, { ok: true }>,
  batchId: string,
  manifestPath: string,
  reportPath: string | null
): CanvasArrangementMigrationOutcome {
  return {
    status: 'migrated',
    sourceVersion: plan.sourceVersion,
    targetVersion: TARGET_VERSION,
    batchId,
    manifestPath,
    reportPath,
    preserved: plan.preserved,
    defaulted: plan.defaulted,
    normalized: plan.normalized,
    unsupported: plan.unsupported
  }
}
