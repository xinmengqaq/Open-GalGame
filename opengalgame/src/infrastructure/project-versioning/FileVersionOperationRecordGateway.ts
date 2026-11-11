import { lstat } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'

import type {
  VersionCallerOperationBinding,
  VersionCallerOperationLink,
  VersionCommitIntent,
  VersionOperationRecord,
  VersionOperationRecordGateway,
  VersionPreparedRecord
} from '@application/project-versioning/ports/VersionOperationRecordGateway'
import type { VersionBoundRetention } from '@application/project-versioning/ports/VersionContentGateway'
import { OPERATION_ID_PATTERN } from '@common/contracts/OperationId'
import { AppException } from '@common/errors/AppException'
import { ErrorCodes } from '@common/errors/ErrorCodes'
import { ProjectVersioningErrorCodes } from '@domain/project-versioning/errors/ProjectVersioningErrorCodes'
import { requireOperationId } from '@domain/project-versioning/services/versionProtocolGuards'
import { readProjectRegistrations } from '@infrastructure/projects/projectRegistrations'
import { resolveRepositoryMetadata } from '@infrastructure/git/containedPath'

import { enqueueWorkWrite } from '@infrastructure/git/transaction/workWriteBoundary'

import { resolveProjectWorkRoot } from './projectWorkRoot'
import {
  listVersionDocuments,
  parseVersionValue,
  readVersionValue,
  versionDocumentPath,
  writeVersionValue
} from './versionStore'

const retentionSchema = z.strictObject({
  relativePath: z.string().min(1),
  action: z.enum(['add', 'modify', 'delete']),
  retentionRef: z.union([z.string().regex(/^[0-9a-f]{64}$/u), z.null()])
})

const operationDocumentSchema = z.strictObject({
  formatVersion: z.literal(1),
  projectId: z.string().min(1),
  operationId: z.string().regex(OPERATION_ID_PATTERN),
  sourceModule: z.string().min(1),
  targets: z.array(z.strictObject({ kind: z.string().min(1), id: z.string().min(1) })),
  changePaths: z.array(z.string().min(1)),
  watchedPaths: z.array(z.string().min(1)),
  baselineRef: z.string().min(1),
  revisionRef: z.string().min(1),
  commitIntent: z.union([
    z.strictObject({
      contentFingerprint: z.string().regex(/^[^\s]{1,256}$/u),
      historyId: z.string().regex(OPERATION_ID_PATTERN),
      saveMode: z.enum(['manual', 'system']),
      contentSource: z.enum(['operation', 'ai']),
      title: z.string().min(1),
      summary: z.string().min(1),
      retentions: z.array(retentionSchema)
    }),
    z.null()
  ])
})

const callerLinkSchema = z.strictObject({
  formatVersion: z.literal(1),
  projectId: z.string().min(1),
  sourceModule: z.string().min(1),
  callerOperationId: z.string().regex(OPERATION_ID_PATTERN),
  operationId: z.string().regex(OPERATION_ID_PATTERN),
  targets: z.array(z.strictObject({ kind: z.string().min(1), id: z.string().min(1) })),
  changePaths: z.array(z.string().min(1)),
  watchedPaths: z.array(z.string().min(1))
})

type CallerLinkDocument = z.infer<typeof callerLinkSchema>

type OperationDocument = z.infer<typeof operationDocumentSchema>

const OPERATION_DIRECTORY = ['opengalgame', 'version-operations']
const CALLER_DIRECTORY = ['opengalgame', 'version-caller-links']
/**
 * 把准备绑定和首次提交意图写在作品仓库元数据中。
 * 记录可在新进程读回，本身不是作品已经提交的证明。
 */
export class FileVersionOperationRecordGateway implements VersionOperationRecordGateway {
  constructor(private readonly userDirectory: string) {}

  async bindPrepared(record: VersionPreparedRecord): Promise<void> {
    const root = await resolveProjectWorkRoot(this.userDirectory, record.projectId)
    await enqueueWorkWrite(root, async () => {
      requireOperationId(record.operationId)
      const existing = await readVersionOperation(root, record.operationId)
      if (existing) {
        if (!samePrepared(existing, record)) throw conflictingOperation()
        return
      }
      await writeVersionOperation(root, { ...record, commitIntent: null })
    })
  }

  async read(projectId: string, operationId: string): Promise<VersionOperationRecord | null> {
    requireOperationId(operationId)
    const root = await resolveProjectWorkRoot(this.userDirectory, projectId)
    const record = await readVersionOperation(root, operationId)
    if (record && record.projectId !== projectId) throw unreadableRecord()
    return record
  }

  async bindCommitIntent(
    projectId: string,
    operationId: string,
    intent: VersionCommitIntent
  ): Promise<void> {
    requireOperationId(operationId)
    requireOperationId(intent.historyId)
    const root = await resolveProjectWorkRoot(this.userDirectory, projectId)
    await enqueueWorkWrite(root, async () => {
      const existing = await readVersionOperation(root, operationId)
      if (!existing || existing.projectId !== projectId) {
        throw new AppException({ code: ErrorCodes.invalidRequest, msg: '操作尚未准备' })
      }
      if (existing.commitIntent) {
        if (existing.commitIntent.contentFingerprint !== intent.contentFingerprint) {
          throw new AppException({
            code: ProjectVersioningErrorCodes.contentFingerprintConflict,
            msg: '同一操作不能更换内容'
          })
        }
        return
      }
      await writeVersionOperation(root, { ...existing, commitIntent: intent })
    })
  }

  async listByProject(projectId: string): Promise<readonly VersionOperationRecord[]> {
    const root = await resolveProjectWorkRoot(this.userDirectory, projectId)
    const directory = await versionDocumentPath(root, OPERATION_DIRECTORY, '.')
    const names = await listVersionDocuments(directory)
    const records: VersionOperationRecord[] = []
    for (const name of names) {
      const operationId = name.slice(0, -'.json'.length)
      if (!OPERATION_ID_PATTERN.test(operationId)) throw unreadableRecord()
      const record = await readVersionOperation(root, operationId)
      if (!record || record.projectId !== projectId || record.operationId !== operationId) {
        throw unreadableRecord()
      }
      records.push(record)
    }
    return records
  }

  async replaceRetentions(
    projectId: string,
    operationId: string,
    retentions: readonly VersionBoundRetention[]
  ): Promise<void> {
    requireOperationId(operationId)
    const root = await resolveProjectWorkRoot(this.userDirectory, projectId)
    await enqueueWorkWrite(root, async () => {
      const existing = await readVersionOperation(root, operationId)
      if (!existing?.commitIntent || existing.projectId !== projectId) {
        throw new AppException({ code: ErrorCodes.invalidRequest, msg: '操作尚未准备' })
      }
      const current = existing.commitIntent.retentions
      if (
        current.length !== retentions.length ||
        current.some(
          (retention, index) =>
            retention.relativePath !== retentions[index]?.relativePath ||
            retention.action !== retentions[index]?.action
        )
      ) {
        throw conflictingOperation()
      }
      await writeVersionOperation(root, {
        ...existing,
        commitIntent: { ...existing.commitIntent, retentions: [...retentions] }
      })
    })
  }

  async bindCallerOperation(binding: VersionCallerOperationBinding): Promise<void> {
    requireOperationId(binding.callerOperationId)
    requireOperationId(binding.operationId)
    const occupied = await this.findCallerOperation(binding.sourceModule, binding.callerOperationId)
    if (
      occupied &&
      (occupied.projectId !== binding.projectId || occupied.operationId !== binding.operationId)
    ) {
      throw conflictingOperation()
    }
    const root = await resolveProjectWorkRoot(this.userDirectory, binding.projectId)
    await enqueueWorkWrite(root, async () => {
      const prepared = await readVersionOperation(root, binding.operationId)
      if (
        !prepared ||
        prepared.projectId !== binding.projectId ||
        prepared.sourceModule !== binding.sourceModule ||
        !sameScope(prepared, binding)
      ) {
        throw conflictingOperation()
      }
      const path = await callerLinkPath(root, binding.sourceModule, binding.callerOperationId)
      const value = await readVersionValue(path)
      if (value !== null) {
        const existing = parseVersionValue(callerLinkSchema, value)
        if (
          existing.projectId !== binding.projectId ||
          existing.sourceModule !== binding.sourceModule ||
          existing.callerOperationId !== binding.callerOperationId ||
          existing.operationId !== binding.operationId ||
          !sameScope(existing, binding)
        ) {
          throw conflictingOperation()
        }
        return
      }
      const document: CallerLinkDocument = {
        formatVersion: 1,
        projectId: binding.projectId,
        sourceModule: binding.sourceModule,
        callerOperationId: binding.callerOperationId,
        operationId: binding.operationId,
        targets: binding.targets.map((target) => ({ kind: target.kind, id: target.id })),
        changePaths: [...binding.changePaths],
        watchedPaths: [...binding.watchedPaths]
      }
      parseVersionValue(callerLinkSchema, document)
      await writeVersionValue(path, document)
    })
  }

  async readCallerOperation(
    projectId: string,
    sourceModule: string,
    callerOperationId: string
  ): Promise<VersionCallerOperationLink | null> {
    requireOperationId(callerOperationId)
    const root = await resolveProjectWorkRoot(this.userDirectory, projectId)
    return readCallerLink(root, projectId, sourceModule, callerOperationId)
  }

  async findCallerOperation(
    sourceModule: string,
    callerOperationId: string
  ): Promise<VersionCallerOperationLink | null> {
    requireOperationId(callerOperationId)
    if (!OPERATION_ID_PATTERN.test(sourceModule)) throw unreadableRecord()
    const registrations = await readProjectRegistrations(this.userDirectory)
    const matches: VersionCallerOperationLink[] = []
    for (const registration of registrations) {
      let root: string
      try {
        root = await resolveProjectWorkRoot(this.userDirectory, registration.id)
      } catch (error) {
        if (error instanceof AppException) throw unreadableRecord()
        throw error
      }
      if (!(await repositoryMetadataReadable(root))) continue
      const link = await readCallerLink(root, registration.id, sourceModule, callerOperationId)
      if (link) matches.push(link)
    }
    if (matches.length === 0) return null
    const [first] = matches
    if (!first || matches.some((link) => link.projectId !== first.projectId)) {
      throw conflictingOperation()
    }
    return first
  }
}

/** 读取本仓库中的版本操作绑定。损坏时失败，不把缺失说成损坏。 */
export async function readVersionOperation(
  projectRoot: string,
  operationId: string
): Promise<VersionOperationRecord | null> {
  const value = await readVersionValue(await operationPath(projectRoot, operationId))
  if (value === null) return null
  const document = parseVersionValue(operationDocumentSchema, value)
  if (document.operationId !== operationId) throw unreadableRecord()
  return toRecord(document)
}

async function writeVersionOperation(
  projectRoot: string,
  record: VersionOperationRecord
): Promise<void> {
  const document = {
    formatVersion: 1 as const,
    projectId: record.projectId,
    operationId: record.operationId,
    sourceModule: record.sourceModule,
    targets: record.targets.map((target) => ({ kind: target.kind, id: target.id })),
    changePaths: [...record.changePaths],
    watchedPaths: [...record.watchedPaths],
    baselineRef: record.baselineRef,
    revisionRef: record.revisionRef,
    commitIntent: record.commitIntent
      ? {
          contentFingerprint: record.commitIntent.contentFingerprint,
          historyId: record.commitIntent.historyId,
          saveMode: record.commitIntent.saveMode,
          contentSource: record.commitIntent.contentSource,
          title: record.commitIntent.title,
          summary: record.commitIntent.summary,
          retentions: record.commitIntent.retentions.map((retention) => ({
            relativePath: retention.relativePath,
            action: retention.action,
            retentionRef: retention.retentionRef
          }))
        }
      : null
  }
  parseVersionValue(operationDocumentSchema, document)
  await writeVersionValue(await operationPath(projectRoot, record.operationId), document)
}

function operationPath(projectRoot: string, operationId: string): Promise<string> {
  return versionDocumentPath(projectRoot, OPERATION_DIRECTORY, `${operationId}.json`)
}

function toRecord(document: OperationDocument): VersionOperationRecord {
  return {
    projectId: document.projectId,
    operationId: document.operationId,
    sourceModule: document.sourceModule,
    targets: document.targets,
    changePaths: document.changePaths,
    watchedPaths: document.watchedPaths,
    baselineRef: document.baselineRef,
    revisionRef: document.revisionRef,
    commitIntent: document.commitIntent
  }
}

function samePrepared(existing: VersionOperationRecord, record: VersionPreparedRecord): boolean {
  return (
    existing.projectId === record.projectId &&
    existing.operationId === record.operationId &&
    existing.sourceModule === record.sourceModule &&
    existing.baselineRef === record.baselineRef &&
    existing.revisionRef === record.revisionRef &&
    sameTexts(existing.changePaths, record.changePaths) &&
    sameTexts(existing.watchedPaths, record.watchedPaths) &&
    existing.targets.length === record.targets.length &&
    existing.targets.every(
      (target, index) =>
        target.kind === record.targets[index]?.kind && target.id === record.targets[index]?.id
    )
  )
}

function sameTexts(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

function conflictingOperation(): AppException {
  return new AppException({
    code: ErrorCodes.operationConflict,
    msg: '同一操作标识对应的请求内容不一致'
  })
}

function unreadableRecord(): AppException {
  return new AppException({
    code: ProjectVersioningErrorCodes.gitQueryFailed,
    msg: '版本记录无法读取'
  })
}
/** 登记目录不是可读 Git 仓库时，这次扫描没有调用方链接。 */
async function repositoryMetadataReadable(projectRoot: string): Promise<boolean> {
  let stats
  try {
    stats = await lstat(join(projectRoot, '.git'))
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return false
    throw error
  }
  if (stats.isSymbolicLink() || !stats.isDirectory()) return false
  await resolveRepositoryMetadata(projectRoot, [])
  return true
}

async function readCallerLink(
  projectRoot: string,
  projectId: string,
  sourceModule: string,
  callerOperationId: string
): Promise<VersionCallerOperationLink | null> {
  const value = await readVersionValue(
    await callerLinkPath(projectRoot, sourceModule, callerOperationId)
  )
  if (value === null) return null
  const document = parseVersionValue(callerLinkSchema, value)
  if (
    document.projectId !== projectId ||
    document.sourceModule !== sourceModule ||
    document.callerOperationId !== callerOperationId
  ) {
    throw unreadableRecord()
  }
  return {
    projectId: document.projectId,
    sourceModule: document.sourceModule,
    callerOperationId: document.callerOperationId,
    operationId: document.operationId
  }
}

function callerLinkPath(
  projectRoot: string,
  sourceModule: string,
  callerOperationId: string
): Promise<string> {
  return versionDocumentPath(
    projectRoot,
    [...CALLER_DIRECTORY, safeModule(sourceModule)],
    `${callerOperationId}.json`
  )
}

function safeModule(sourceModule: string): string {
  if (!OPERATION_ID_PATTERN.test(sourceModule)) throw unreadableRecord()
  return sourceModule
}

function sameScope(
  existing: {
    targets: readonly { kind: string; id: string }[]
    changePaths: readonly string[]
    watchedPaths: readonly string[]
  },
  binding: VersionCallerOperationBinding
): boolean {
  return (
    sameTexts(existing.changePaths, binding.changePaths) &&
    sameTexts(existing.watchedPaths, binding.watchedPaths) &&
    existing.targets.length === binding.targets.length &&
    existing.targets.every(
      (target, index) =>
        target.kind === binding.targets[index]?.kind && target.id === binding.targets[index]?.id
    )
  )
}
