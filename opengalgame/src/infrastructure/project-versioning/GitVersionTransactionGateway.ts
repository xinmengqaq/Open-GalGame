import * as fs from 'node:fs'
import { lstat, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as git from 'isomorphic-git'
import { z } from 'zod'

import type {
  EnsureDeclaredPathsRequest,
  InitializeBaselineRequest,
  VersionBaselineFact,
  VersionCommitExecution,
  VersionCommitRequest,
  VersionLimitedChange,
  VersionRollbackExecution,
  VersionRollbackRequest,
  VersionScopeBaseline,
  VersionTransactionGateway,
  VersionTransactionView
} from '@application/project-versioning/ports/VersionTransactionGateway'
import type { CallerOperationState } from '@application/project-versioning/vo/ProjectVersioningVO'
import { OPERATION_ID_PATTERN } from '@common/contracts/OperationId'
import { AppException } from '@common/errors/AppException'
import { ErrorCodes } from '@common/errors/ErrorCodes'
import { ProjectVersioningErrorCodes } from '@domain/project-versioning/errors/ProjectVersioningErrorCodes'
import {
  requireContentFingerprint,
  requireOperationId
} from '@domain/project-versioning/services/versionProtocolGuards'
import { assertRelativePath, resolveContained } from '@infrastructure/git/containedPath'
import { realGitEffects, type GitEffects } from '@infrastructure/git/gitEffects'
import { asGitException } from '@infrastructure/git/gitErrors'
import { bytesEqual, digestBytes } from '@infrastructure/git/objects/gitContent'
import {
  applyTreeEdits,
  isReachableFromHead,
  readCommitFile,
  type TreeEdit
} from '@infrastructure/git/objects/gitTree'
import { writeCandidateRevision } from '@infrastructure/git/objects/writeCandidateRevision'
import { readWorkBaseline } from '@infrastructure/git/repository/WorkBaseline'
import {
  assertWorkRepository,
  readBranchRef,
  readHead
} from '@infrastructure/git/repository/repositoryGuard'
import type {
  ContentPresence,
  OperationCommitState,
  WorkBaseline
} from '@infrastructure/git/GitRepository'
import {
  restoreRecordedFiles,
  verifyCompensationBackup
} from '@infrastructure/git/transaction/CommitCompensation'
import {
  commitLimited,
  repairPublishedMetadata
} from '@infrastructure/git/transaction/LimitedCommit'
import {
  assessOperation,
  findPublishedRollback,
  provePublishedOperation
} from '@infrastructure/git/transaction/OperationQuery'
import {
  listOperationRecordIds,
  readOperationRecord,
  type OperationRecord
} from '@infrastructure/git/transaction/OperationRecord'
import { rollbackLimited } from '@infrastructure/git/transaction/OperationRollback'
import { enqueueWorkWrite } from '@infrastructure/git/transaction/workWriteBoundary'

import { readRetainedBlob } from './FileVersionContentGateway'
import { assertScopeBaselineInput, observeCommitScope } from './CommitScopeObservation'
import {
  listCallerIntentsAt,
  listVersionOperationsAt,
  markCallerNotStartedAt,
  readCallerIntentAt,
  readVersionOperation,
  setCallerStateAt
} from './FileVersionOperationRecordGateway'
import { resolveProjectWorkRoot } from './projectWorkRoot'
import {
  parseVersionValue,
  readVersionValue,
  versionDocumentPath,
  writeVersionValue
} from './versionStore'

const CHANGED_AT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/u
const COMMIT_PATTERN = /^[0-9a-f]{40}$/u
const SETTLEMENT_DIRECTORY = ['opengalgame', 'version-settlements']

const settlementSchema = z.strictObject({
  formatVersion: z.literal(1),
  operationId: z.string().regex(OPERATION_ID_PATTERN),
  contentFingerprint: z.string().regex(/^[^\s]{1,256}$/u),
  outcome: z.union([
    z.strictObject({
      state: z.literal('已提交'),
      revisionRef: z.string().regex(COMMIT_PATTERN),
      changedAt: z.string().regex(CHANGED_AT_PATTERN)
    }),
    z.strictObject({
      state: z.literal('无变更'),
      revisionRef: z.string().regex(COMMIT_PATTERN),
      changedAt: z.string().regex(CHANGED_AT_PATTERN)
    }),
    z.strictObject({
      state: z.literal('已回退'),
      originalRevisionRef: z.string().regex(COMMIT_PATTERN),
      revisionRef: z.string().regex(COMMIT_PATTERN),
      changedAt: z.string().regex(CHANGED_AT_PATTERN)
    }),
    z.strictObject({ state: z.literal('未提交') })
  ])
})

type VersionSettlement = z.infer<typeof settlementSchema>
type SettlementWriter = (root: string, settlement: VersionSettlement) => Promise<void>

export class GitVersionTransactionGateway implements VersionTransactionGateway {
  constructor(
    private readonly userDirectory: string,
    private readonly effects: GitEffects = realGitEffects,
    private readonly settlementWriter: SettlementWriter = writeSettlement
  ) {}

  async initializeBaseline(input: InitializeBaselineRequest): Promise<VersionBaselineFact> {
    for (const relativePath of input.initialPaths) assertRelativePath(relativePath)
    const root = await resolveProjectWorkRoot(this.userDirectory, input.projectId)
    return enqueueWorkWrite(root, async () => {
      const created = await ensureRepository(root)
      if (!created) {
        try {
          return factOf(await readHead(root))
        } catch (error) {
          if (!isCode(error, ProjectVersioningErrorCodes.gitNoCommits)) throw error
        }
      }
      await createFirstBaseline(root, input.initialPaths, created)
      return factOf(await readHead(root))
    })
  }

  async ensureDeclaredPaths(input: EnsureDeclaredPathsRequest): Promise<VersionBaselineFact> {
    for (const relativePath of input.paths) assertRelativePath(relativePath)
    const root = await resolveProjectWorkRoot(this.userDirectory, input.projectId)
    return enqueueWorkWrite(root, () => ensureDeclaredPathsInside(root, input.paths, this.effects))
  }

  async readBaseline(projectId: string): Promise<VersionBaselineFact | null> {
    const root = await resolveProjectWorkRoot(this.userDirectory, projectId)
    try {
      await assertWorkRepository(root)
      return factOf(await readHead(root))
    } catch (error) {
      if (
        isCode(error, ProjectVersioningErrorCodes.gitNotRepository) ||
        isCode(error, ProjectVersioningErrorCodes.gitNoCommits)
      ) {
        return null
      }
      throw error instanceof AppException
        ? error
        : asGitException(error, ProjectVersioningErrorCodes.gitQueryFailed, '作品版本读取失败')
    }
  }

  async inspectDeclaredPaths(input: EnsureDeclaredPathsRequest): Promise<boolean> {
    for (const relativePath of input.paths) assertRelativePath(relativePath)
    const root = await resolveProjectWorkRoot(this.userDirectory, input.projectId)
    try {
      await assertWorkRepository(root)
      const head = await readHead(root)
      for (const relativePath of uniquePaths(input.paths)) {
        const committed = await readCommitFile({ dir: root }, head.commitId, relativePath)
        if (committed === null) return false
      }
      return true
    } catch (error) {
      if (
        isCode(error, ProjectVersioningErrorCodes.gitNotRepository) ||
        isCode(error, ProjectVersioningErrorCodes.gitNoCommits) ||
        isCode(error, ProjectVersioningErrorCodes.gitQueryFailed) ||
        isCode(error, ProjectVersioningErrorCodes.gitUnavailable)
      ) {
        return false
      }
      throw error instanceof AppException
        ? error
        : asGitException(error, ProjectVersioningErrorCodes.gitQueryFailed, '作品版本读取失败')
    }
  }

  async readTransaction(
    projectId: string,
    operationId: string
  ): Promise<VersionTransactionView | null> {
    requireOperationId(operationId)
    const root = await resolveProjectWorkRoot(this.userDirectory, projectId)
    return readTransactionAt(root, operationId)
  }

  async commit(input: VersionCommitRequest): Promise<VersionCommitExecution> {
    requireOperationId(input.operationId)
    requireContentFingerprint(input.contentFingerprint)
    if (input.changes.length === 0) {
      throw new AppException({ code: ErrorCodes.invalidRequest, msg: '没有可提交的路径' })
    }
    assertScopeBaselineInput(input)
    const root = await resolveProjectWorkRoot(this.userDirectory, input.projectId)
    return enqueueWorkWrite(root, async () => {
      if (input.sourceModule === 'project-files') {
        await recoverProjectInside(root, input.projectId, 'project-files', this.effects)
        const resolved = await resolveCallerIntentsInside(
          root,
          input.projectId,
          'project-files',
          [],
          input.callerOperationId
        )
        if (
          resolved.some(
            (item) =>
              item.state === 'pending' &&
              item.callerOperationId !== input.callerOperationId
          )
        ) {
          throw recoveryFailure('同工程仍有未核实的 caller 操作')
        }
        if (input.callerOperationId) {
          const caller = await readCallerIntentAt(
            root,
            input.projectId,
            'project-files',
            input.callerOperationId
          )
          if (caller?.state === 'notStarted' || caller?.state === 'notCommitted') {
            throw new AppException({
              code: ErrorCodes.operationConflict,
              msg: '操作已终止，不能重试'
            })
          }
          if (caller) {
            const settlement = await readSettlement(root, caller.operationId)
            if (settlement?.outcome.state === '未提交') {
              await setCallerStateAt(
                root,
                input.projectId,
                'project-files',
                input.callerOperationId,
                caller.operationId,
                'notCommitted'
              )
              throw new AppException({
                code: ErrorCodes.operationConflict,
                msg: '操作未提交，不能重试'
              })
            }
            if (
              caller.state === 'committed' &&
              settlement?.outcome.state !== '已提交' &&
              settlement?.outcome.state !== '无变更'
            ) {
              throw new AppException({
                code: ProjectVersioningErrorCodes.gitQueryFailed,
                msg: '已提交 caller 缺少可靠结算'
              })
            }
          }
        }
      }
      return publishInside(root, input, this.effects, this.settlementWriter)
    })
  }

  async rollback(input: VersionRollbackRequest): Promise<VersionRollbackExecution> {
    requireOperationId(input.operationId)
    const root = await resolveProjectWorkRoot(this.userDirectory, input.projectId)
    return enqueueWorkWrite(root, async () => {
      const read = await readOperationRecord(root, input.operationId)
      if (read.kind === 'ok' && read.record.sourceModule === 'project-files') {
        await recoverProjectInside(root, input.projectId, 'project-files', this.effects)
        const resolved = await resolveCallerIntentsInside(
          root,
          input.projectId,
          'project-files'
        )
        if (resolved.some((item) => item.state === 'pending')) {
          throw recoveryFailure('同工程仍有未核实的 caller 操作')
        }
      }
      return rollbackInside(root, input, this.effects)
    })
  }

  async recoverProject(projectId: string, sourceModule: string): Promise<void> {
    if (sourceModule.trim().length === 0) {
      throw new AppException({ code: ErrorCodes.invalidRequest, msg: '来源模块不正确' })
    }
    const root = await resolveProjectWorkRoot(this.userDirectory, projectId)
    return enqueueWorkWrite(root, async () => {
      await recoverProjectInside(root, projectId, sourceModule, this.effects)
      const resolved = await resolveCallerIntentsInside(root, projectId, sourceModule)
      if (resolved.some((item) => item.state === 'pending')) {
        throw recoveryFailure('工程仍有未核实的 caller 操作')
      }
    })
  }

  async resolveCallerOperations(
    projectId: string,
    sourceModule: string,
    callerOperationIds: readonly string[]
  ): Promise<readonly { callerOperationId: string; state: CallerOperationState }[]> {
    const root = await resolveProjectWorkRoot(this.userDirectory, projectId)
    return enqueueWorkWrite(root, async () => {
      await recoverProjectInside(root, projectId, sourceModule, this.effects)
      return resolveCallerIntentsInside(
        root,
        projectId,
        sourceModule,
        callerOperationIds
      )
    })
  }
}

async function recoverProjectInside(
  root: string,
  projectId: string,
  sourceModule: string,
  effects: GitEffects
): Promise<void> {
  void projectId
  for (const operationId of await listOperationRecordIds(root)) {
    const read = await readOperationRecord(root, operationId)
    if (read.kind !== 'ok') {
      throw recoveryFailure('技术操作记录缺失或损坏，无法恢复')
    }
    let record = read.record
    if (record.sourceModule === undefined) {
      const stored = await readVersionOperation(root, operationId)
      if (!stored) {
        throw recoveryFailure('技术操作记录来源未知，不能跳过')
      }
      if (stored.sourceModule !== sourceModule) continue
      record = { ...record, sourceModule: stored.sourceModule }
      try {
        await effects.writeRecord(root, record)
      } catch (error) {
        throw recoveryFailure('来源模块记录写入失败', error)
      }
    }
    if (record.sourceModule !== sourceModule) continue
    if (record.forwardCommitId && record.phase !== 'compensated') {
      const publishedRollback = await findPublishedRollback(root, record)
      if (publishedRollback) {
        if (record.rollbackCommitId && record.rollbackCommitId !== publishedRollback) {
          throw recoveryFailure('回退提交记录与历史不一致')
        }
        let repaired = record
        if (
          record.phase !== 'rolled-back' ||
          record.rollbackCommitId !== publishedRollback
        ) {
          repaired = {
            ...record,
            phase: 'rolled-back' as const,
            rollbackCommitId: publishedRollback
          }
          try {
            await effects.writeRecord(root, repaired)
          } catch (error) {
            throw recoveryFailure('已发布回退记录补写失败', error)
          }
        }
        await ensureRolledBackSettlement(root, repaired, publishedRollback)
        continue
      }
    }
    if (record.phase === 'rolled-back') {
      const state = await assessOperation(root, operationId).catch((error: unknown) => {
        throw recoveryFailure('记录标记已回退但回退提交证据冲突', error)
      })
      if (state.state !== 'rolledBack') {
        throw recoveryFailure('记录标记已回退但没有可证明的回退提交')
      }
      await ensureRolledBackSettlement(root, record, state.rollbackCommitId)
      continue
    }
    if (record.phase === 'compensated') {
      const state = await assessOperation(root, operationId)
      if (state.state !== 'notCommitted') {
        throw recoveryFailure('补偿记录仍包含已发布或不一致的提交证据')
      }
      await ensureUncommittedSettlement(root, record)
      continue
    }
    if (record.phase === 'rollback-required') {
      if (record.sourceModule !== 'project-files') {
        throw recoveryFailure('检测到非 project-files 回退中的操作，保持原失败语义')
      }
      const published = await rollbackLimited(root, operationId, effects, {
        backupBeforeRestore: true
      })
      const repaired = await readOperationRecord(root, operationId)
      if (repaired.kind !== 'ok') {
        throw recoveryFailure('回退恢复后的技术记录无法读取')
      }
      await ensureRolledBackSettlement(root, repaired.record, published.rollbackCommitId)
      continue
    }
    const proof = await provePublishedOperation(root, operationId)
    if (proof.state === 'conflict') throw recoveryFailure(proof.detail)
    if (proof.state === 'committed') {
      const repaired = await repairPublishedMetadata(root, operationId, effects)
      if (repaired === 'conflict') throw recoveryFailure('已发布操作元数据冲突')
      if (repaired === 'write-failed') throw recoveryFailure('已发布操作元数据补写失败')
      await ensureCommittedSettlement(root, record, proof.commitId)
      continue
    }
    if (record.phase === 'published') {
      throw recoveryFailure('记录标记已发布但无法证明提交')
    }
    if (record.phase === 'restoring' && !record.compensationBackupId) {
      throw recoveryFailure('恢复中记录缺少备份关联')
    }
    if (record.compensationBackupId) {
      await verifyCompensationBackup(root, record, record.compensationBackupId)
    }
    await restoreRecordedFiles(root, record, effects, new Map(), {
      backupBeforeRestore: true
    })
    await ensureUncommittedSettlement(root, record)
  }
}

async function resolveCallerIntentsInside(
  root: string,
  projectId: string,
  sourceModule: string,
  requestedCallerIds: readonly string[] = [],
  excludedCallerId?: string
): Promise<readonly { callerOperationId: string; state: CallerOperationState }[]> {
  const links = await listCallerIntentsAt(root, projectId, sourceModule)
  const records = (await listVersionOperationsAt(root)).filter(
    (record) => record.projectId === projectId && record.sourceModule === sourceModule
  )
  const recordsByCaller = new Map<string, (typeof records)[number]>()
  for (const record of records) {
    if (!record.callerOperationId) continue
    if (recordsByCaller.has(record.callerOperationId)) {
      throw recoveryFailure('同一 caller 身份对应多个版本意图')
    }
    recordsByCaller.set(record.callerOperationId, record)
  }
  const callerIds = new Set<string>([
    ...links.map((link) => link.callerOperationId),
    ...recordsByCaller.keys(),
    ...requestedCallerIds
  ])
  const result: Array<{ callerOperationId: string; state: CallerOperationState }> = []
  for (const callerOperationId of callerIds) {
    const link = links.find((item) => item.callerOperationId === callerOperationId)
    if (link?.state === 'notStarted' || link?.state === 'committed' || link?.state === 'notCommitted') {
      result.push({ callerOperationId, state: link.state })
      continue
    }
    const record = recordsByCaller.get(callerOperationId)
    const operationId = link?.operationId ?? record?.operationId
    if (!operationId) {
      if (callerOperationId === excludedCallerId) {
        result.push({ callerOperationId, state: 'pending' })
        continue
      }
      await markCallerNotStartedAt(root, projectId, sourceModule, callerOperationId)
      result.push({ callerOperationId, state: 'notStarted' })
      continue
    }
    const technical = await readOperationRecord(root, operationId)
    if (technical.kind === 'damaged') {
      throw recoveryFailure('caller 关联的技术记录损坏')
    }
    if (technical.kind === 'missing') {
      if (!record) {
        throw recoveryFailure('caller 关联的版本意图缺失')
      }
      if (callerOperationId === excludedCallerId) {
        result.push({ callerOperationId, state: 'pending' })
        continue
      }
      await setCallerStateAt(
        root,
        projectId,
        sourceModule,
        callerOperationId,
        operationId,
        'notStarted'
      )
      result.push({ callerOperationId, state: 'notStarted' })
      continue
    }
    const settlement = await readSettlement(root, operationId)
    const state =
      settlement?.outcome.state === '已提交' || settlement?.outcome.state === '无变更'
        ? 'committed'
        : settlement?.outcome.state === '未提交'
          ? 'notCommitted'
          : 'pending'
    if (state !== 'pending') {
      await setCallerStateAt(
        root,
        projectId,
        sourceModule,
        callerOperationId,
        operationId,
        state
      )
    }
    result.push({ callerOperationId, state })
  }
  return result
}

async function ensureUncommittedSettlement(
  root: string,
  record: OperationRecord
): Promise<void> {
  const fingerprint = await settlementFingerprint(root, record)
  const existing = await readSettlement(root, record.operationId)
  if (existing) {
    if (
      existing.outcome.state === '未提交' &&
      existing.contentFingerprint === fingerprint
    ) {
      return
    }
    throw recoveryFailure('补偿记录结算与操作状态冲突')
  }
  try {
    await writeSettlement(root, {
      formatVersion: 1,
      operationId: record.operationId,
      contentFingerprint: fingerprint,
      outcome: { state: '未提交' }
    })
  } catch (error) {
    throw recoveryFailure('未提交结算补写失败', error)
  }
}

async function ensureCommittedSettlement(
  root: string,
  record: OperationRecord,
  commitId: string
): Promise<void> {
  const fingerprint = await settlementFingerprint(root, record)
  const existing = await readSettlement(root, record.operationId)
  if (existing) {
    if (
      existing.outcome.state === '已提交' &&
      existing.outcome.revisionRef === commitId &&
      existing.contentFingerprint === fingerprint
    ) {
      return
    }
    throw recoveryFailure('已发布结算与操作记录冲突')
  }
  try {
    const changedAt = await changedAtOf(root, commitId)
    await writeSettlement(root, {
      formatVersion: 1,
      operationId: record.operationId,
      contentFingerprint: fingerprint,
      outcome: { state: '已提交', revisionRef: commitId, changedAt }
    })
  } catch (error) {
    throw recoveryFailure('已发布结算补写失败', error)
  }
}

async function ensureRolledBackSettlement(
  root: string,
  record: OperationRecord,
  rollbackCommitId: string
): Promise<void> {
  const forwardCommitId = record.forwardCommitId
  if (!forwardCommitId) throw recoveryFailure('回退记录缺少前向提交标识')
  const fingerprint = await settlementFingerprint(root, record)
  const existing = await readSettlement(root, record.operationId)
  if (existing) {
    if (existing.contentFingerprint !== fingerprint) {
      throw recoveryFailure('回退结算与操作指纹冲突')
    }
    if (
      existing.outcome.state === '已回退' &&
      existing.outcome.originalRevisionRef === forwardCommitId &&
      existing.outcome.revisionRef === rollbackCommitId
    ) {
      return
    }
    if (
      existing.outcome.state !== '已提交' &&
      existing.outcome.state !== '已回退'
    ) {
      throw recoveryFailure('回退结算与操作状态冲突')
    }
    if (
      existing.outcome.state === '已提交' &&
      existing.outcome.revisionRef !== forwardCommitId
    ) {
      throw recoveryFailure('回退结算的前向提交与记录不一致')
    }
  }
  try {
    const changedAt = await changedAtOf(root, rollbackCommitId)
    await writeSettlement(root, {
      formatVersion: 1,
      operationId: record.operationId,
      contentFingerprint: fingerprint,
      outcome: {
        state: '已回退',
        originalRevisionRef: forwardCommitId,
        revisionRef: rollbackCommitId,
        changedAt
      }
    })
  } catch (error) {
    throw recoveryFailure('回退结算补写失败', error)
  }
}

async function settlementFingerprint(
  root: string,
  record: OperationRecord
): Promise<string> {
  const stored = await readVersionOperation(root, record.operationId)
  return stored?.commitIntent?.contentFingerprint ?? record.fingerprint
}

function recoveryFailure(message: string, cause?: unknown): AppException {
  return new AppException({
    code: ProjectVersioningErrorCodes.gitQueryFailed,
    msg: message,
    cause
  })
}

async function publishInside(
  root: string,
  input: VersionCommitRequest,
  effects: GitEffects,
  settlementWriter: SettlementWriter
): Promise<VersionCommitExecution> {
  const paths = uniquePaths(input.changes.map((change) => assertRelativePath(change.relativePath)))
  const record = await readVersionOperation(root, input.operationId)
  const scope = uniquePaths([...paths, ...(record?.watchedPaths ?? [])])
  const observation = await observeCommit(
    root,
    input.operationId,
    scope,
    input.changes,
    input.scopeBaseline
  )
  if (
    input.scopeBaseline !== undefined &&
    !(await isReachableFromHead(root, input.scopeBaseline.revisionRef))
  ) {
    throw baselineConflict()
  }
  const decision = await input.verify(observation)
  if (decision.action === 'reuse') return reuseCommit(root, input.operationId)
  const fresh = await observeCommit(
    root,
    input.operationId,
    scope,
    input.changes,
    input.scopeBaseline
  )
  if (fresh.subsequentPaths.length > 0) throw baselineConflict()
  if (input.scopeBaseline === undefined && fresh.baseline.revisionRef !== input.baselineRef) {
    throw baselineConflict()
  }
  const loaded = await loadChanges(root, fresh.baseline.revisionRef, input.changes)
  if (loaded.length === 0) return persistNoChange(root, input, fresh.baseline.revisionRef)
  try {
    return await publishChanges(root, input, loaded, effects, settlementWriter, fresh.work)
  } catch (error) {
    return classifyCommitFailure(root, input, error, effects, settlementWriter)
  }
}

async function rollbackInside(
  root: string,
  input: VersionRollbackRequest,
  effects: GitEffects
): Promise<VersionRollbackExecution> {
  const owned = uniquePaths(input.ownedPaths.map((path) => assertRelativePath(path)))
  const observation = await observeRollback(root, input.operationId, owned)
  const decision = await input.verify(observation)
  if (decision.action === 'reuse') return reuseRollback(root, input.operationId)
  const fresh = await observeRollback(root, input.operationId, owned)
  if (input.backupBeforeRestore !== true && fresh.subsequentPaths.length > 0) {
    throw new AppException({
      code: ErrorCodes.operationConflict,
      msg: '目标路径已有后续修改，已拒绝回退'
    })
  }
  try {
    const published = await rollbackLimited(root, input.operationId, effects, {
      backupBeforeRestore: input.backupBeforeRestore === true
    })
    return await rememberRollback(root, input.operationId, published.rollbackCommitId)
  } catch (error) {
    const state = await assessQuietly(root, input.operationId)
    if (state?.state === 'rolledBack')
      return rememberRollback(root, input.operationId, state.rollbackCommitId)
    if (!state || state.state === 'unknown' || state.state === 'rollbackRequired') {
      return { state: '待核对' }
    }
    throw error instanceof AppException
      ? error
      : asGitException(error, ProjectVersioningErrorCodes.gitUnavailable, '作品回退失败')
  }
}

async function publishChanges(
  root: string,
  input: VersionCommitRequest,
  changes: readonly LoadedChange[],
  effects: GitEffects,
  settlementWriter: SettlementWriter,
  observed: WorkBaseline
): Promise<VersionCommitExecution> {
  const parent = await mkdtemp(join(tmpdir(), 'opengalgame-version-'))
  const gitDir = join(parent, 'candidate')
  try {
    const revision = await writeCandidateRevision(
      gitDir,
      changes
        .filter((change) => change.action !== 'delete')
        .map((change) => ({
          relativePath: change.relativePath,
          action: 'upsert' as const,
          bytes: change.bytes
        }))
    )
    const expectedBaseline: WorkBaseline = {
      headCommitId: observed.headCommitId,
      branch: observed.branch,
      paths: observed.paths
    }
    if (input.scopeBaseline === undefined && expectedBaseline.headCommitId !== input.baselineRef) {
      throw baselineConflict()
    }
    const published = await commitLimited(
      {
        projectRoot: root,
        operationId: input.operationId,
        sourceModule: input.sourceModule,
        expectedBaseline,
        changes: changes.map(({ relativePath, action }) => ({ relativePath, action })),
        candidate: { gitDir, revisionId: revision.revisionId },
        advanceBaseline: input.scopeBaseline !== undefined,
        backupBeforeRestore: input.backupBeforeRestore === true,
        recheck: async (fresh) => {
          if (
            fresh.headCommitId !== expectedBaseline.headCommitId ||
            fresh.branch !== expectedBaseline.branch
          ) {
            throw baselineConflict()
          }
        }
      },
      effects
    )
    return rememberCommit(root, input, published.commitId, settlementWriter)
  } finally {
    await rm(parent, { recursive: true, force: true })
  }
}

async function classifyCommitFailure(
  root: string,
  input: VersionCommitRequest,
  error: unknown,
  effects: GitEffects,
  settlementWriter: SettlementWriter
): Promise<VersionCommitExecution> {
  const proof = await provePublishedOperation(root, input.operationId).catch(
    (proofError: unknown) => {
      throw asGitException(
        proofError,
        ProjectVersioningErrorCodes.gitQueryFailed,
        '提交结果无法核对'
      )
    }
  )
  if (proof.state === 'committed') {
    const repaired = await repairPublishedMetadata(root, input.operationId, effects)
    if (repaired === 'conflict') {
      throw new AppException({
        code: ProjectVersioningErrorCodes.gitQueryFailed,
        msg: '提交结果与记录证据冲突'
      })
    }
    return rememberCommit(root, input, proof.commitId, settlementWriter)
  }
  if (proof.state === 'conflict') {
    throw new AppException({
      code: ProjectVersioningErrorCodes.gitQueryFailed,
      msg: proof.detail
    })
  }
  throw error instanceof AppException
    ? error
    : asGitException(error, ProjectVersioningErrorCodes.gitUnavailable, '作品提交失败')
}

async function rememberCommit(
  root: string,
  input: VersionCommitRequest,
  revisionRef: string,
  settlementWriter: SettlementWriter
): Promise<VersionCommitExecution> {
  const changedAt = await changedAtOf(root, revisionRef)
  try {
    await settlementWriter(root, {
      formatVersion: 1,
      operationId: input.operationId,
      contentFingerprint: input.contentFingerprint,
      outcome: { state: '已提交', revisionRef, changedAt }
    })
  } catch {
  }
  return { state: '已提交', revisionRef, changedAt }
}

async function persistNoChange(
  root: string,
  input: VersionCommitRequest,
  observedRevisionRef: string
): Promise<VersionCommitExecution> {
  const existing = await readSettlement(root, input.operationId)
  if (
    existing?.outcome.state === '无变更' &&
    existing.contentFingerprint === input.contentFingerprint
  ) {
    return {
      state: '无变更',
      revisionRef: existing.outcome.revisionRef,
      changedAt: existing.outcome.changedAt
    }
  }
  if (existing && existing.contentFingerprint !== input.contentFingerprint) {
    throw new AppException({
      code: ProjectVersioningErrorCodes.contentFingerprintConflict,
      msg: '同一操作不能更换内容'
    })
  }
  const changedAt = await changedAtOf(root, observedRevisionRef)
  await writeSettlement(root, {
    formatVersion: 1,
    operationId: input.operationId,
    contentFingerprint: input.contentFingerprint,
    outcome: { state: '无变更', revisionRef: observedRevisionRef, changedAt }
  })
  return { state: '无变更', revisionRef: observedRevisionRef, changedAt }
}

async function rememberRollback(
  root: string,
  operationId: string,
  revisionRef: string
): Promise<VersionRollbackExecution> {
  const technical = await readOperationRecord(root, operationId)
  const fingerprint = await fingerprintFor(root, operationId)
  if (technical.kind !== 'ok' || !technical.record.forwardCommitId || !fingerprint) {
    return { state: '待核对' }
  }
  const changedAt = await changedAtOf(root, revisionRef)
  await writeSettlement(root, {
    formatVersion: 1,
    operationId,
    contentFingerprint: fingerprint,
    outcome: {
      state: '已回退',
      originalRevisionRef: technical.record.forwardCommitId,
      revisionRef,
      changedAt
    }
  })
  return {
    state: '已回退',
    originalRevisionRef: technical.record.forwardCommitId,
    revisionRef,
    changedAt
  }
}

async function reuseCommit(root: string, operationId: string): Promise<VersionCommitExecution> {
  const current = await readTransactionAt(root, operationId)
  if (current?.outcome.state === '已提交' || current?.outcome.state === '无变更') {
    return {
      state: current.outcome.state,
      revisionRef: current.outcome.revisionRef,
      changedAt: current.outcome.changedAt
    }
  }
  throw new AppException({
    code: ProjectVersioningErrorCodes.insufficientEvidence,
    msg: '提交结果不明，不能重试'
  })
}

async function reuseRollback(root: string, operationId: string): Promise<VersionRollbackExecution> {
  const current = await readTransactionAt(root, operationId)
  if (current?.outcome.state === '已回退') {
    return {
      state: '已回退',
      originalRevisionRef: current.outcome.originalRevisionRef,
      revisionRef: current.outcome.revisionRef,
      changedAt: current.outcome.changedAt
    }
  }
  throw new AppException({
    code: ProjectVersioningErrorCodes.insufficientEvidence,
    msg: '回退结果不明，不能再次回退'
  })
}

async function readTransactionAt(
  root: string,
  operationId: string
): Promise<VersionTransactionView | null> {
  try {
    await assertWorkRepository(root)
  } catch (error) {
    if (isCode(error, ProjectVersioningErrorCodes.gitNotRepository)) return null
    throw error instanceof AppException
      ? error
      : asGitException(error, ProjectVersioningErrorCodes.gitQueryFailed, '作品版本读取失败')
  }
  const state = await assessOperation(root, operationId)
  const settlement = await readSettlement(root, operationId)
  if (state.state === 'committed')
    return committedView(root, operationId, state.commitId, settlement)
  if (state.state === 'rolledBack') {
    return rolledBackView(root, operationId, state.commitId, state.rollbackCommitId, settlement)
  }
  if (state.state === 'unknown' || state.state === 'rollbackRequired') {
    return pendingView(root, operationId, settlement)
  }
  if (state.state === 'notCommitted' && settlement?.outcome.state === '未提交') {
    return {
      operationId,
      contentFingerprint: settlement.contentFingerprint,
      outcome: { state: '未提交' }
    }
  }
  if (settlement?.outcome.state === '无变更') {
    return {
      operationId,
      contentFingerprint: settlement.contentFingerprint,
      outcome: settlement.outcome
    }
  }
  return null
}

async function committedView(
  root: string,
  operationId: string,
  revisionRef: string,
  settlement: VersionSettlement | null
): Promise<VersionTransactionView> {
  if (settlement?.outcome.state === '已提交' && settlement.outcome.revisionRef === revisionRef) {
    return {
      operationId,
      contentFingerprint: settlement.contentFingerprint,
      outcome: settlement.outcome
    }
  }
  const fingerprint = await fingerprintFor(root, operationId)
  if (!fingerprint || !(await commitMatchesIntent(root, operationId, revisionRef))) {
    return pendingView(root, operationId, settlement)
  }
  const changedAt = await changedAtOf(root, revisionRef)
  const outcome = { state: '已提交' as const, revisionRef, changedAt }
  return { operationId, contentFingerprint: fingerprint, outcome }
}

async function rolledBackView(
  root: string,
  operationId: string,
  originalRevisionRef: string,
  revisionRef: string,
  settlement: VersionSettlement | null
): Promise<VersionTransactionView> {
  if (
    settlement?.outcome.state === '已回退' &&
    settlement.outcome.originalRevisionRef === originalRevisionRef &&
    settlement.outcome.revisionRef === revisionRef
  ) {
    return {
      operationId,
      contentFingerprint: settlement.contentFingerprint,
      outcome: settlement.outcome
    }
  }
  const fingerprint = await fingerprintFor(root, operationId)
  if (!fingerprint || !(await commitMatchesIntent(root, operationId, originalRevisionRef))) {
    return pendingView(root, operationId, settlement)
  }
  const changedAt = await changedAtOf(root, revisionRef)
  const outcome = { state: '已回退' as const, originalRevisionRef, revisionRef, changedAt }
  return { operationId, contentFingerprint: fingerprint, outcome }
}

async function pendingView(
  root: string,
  operationId: string,
  settlement: VersionSettlement | null
): Promise<VersionTransactionView> {
  const fingerprint = settlement?.contentFingerprint ?? (await fingerprintFor(root, operationId))
  if (!fingerprint) {
    throw new AppException({
      code: ProjectVersioningErrorCodes.gitQueryFailed,
      msg: '作品提交结果尚未查明，已保留证据'
    })
  }
  return { operationId, contentFingerprint: fingerprint, outcome: { state: '待核对' } }
}

type CommitObservation = {
  readonly baseline: VersionBaselineFact
  readonly subsequentPaths: readonly string[]
  readonly transaction: VersionTransactionView | null
  readonly work: WorkBaseline
}

async function observeCommit(
  root: string,
  operationId: string,
  scope: readonly string[],
  changes: readonly VersionLimitedChange[],
  scopeBaseline: VersionScopeBaseline | undefined
): Promise<CommitObservation> {
  const observed = await observeCommitScope(root, scope, changes, scopeBaseline)
  return {
    baseline: {
      baselineRef: observed.work.headCommitId,
      revisionRef: observed.work.headCommitId
    },
    subsequentPaths: observed.subsequentPaths,
    transaction: await readTransactionAt(root, operationId),
    work: observed.work
  }
}

async function observeRollback(
  root: string,
  operationId: string,
  ownedPaths: readonly string[]
): Promise<{ subsequentPaths: readonly string[]; transaction: VersionTransactionView | null }> {
  const transaction = await readTransactionAt(root, operationId)
  const forward =
    transaction?.outcome.state === '已提交'
      ? transaction.outcome.revisionRef
      : transaction?.outcome.state === '已回退'
        ? transaction.outcome.originalRevisionRef
        : null
  const subsequentPaths = forward ? await driftedPaths(root, ownedPaths, forward) : []
  return { subsequentPaths, transaction }
}

async function driftedPaths(
  root: string,
  ownedPaths: readonly string[],
  forwardCommit: string
): Promise<string[]> {
  if (ownedPaths.length === 0) return []
  const baseline = await readWorkBaseline(root, ownedPaths)
  const drifted: string[] = []
  for (const path of baseline.paths) {
    const forward = await readCommitFile({ dir: root }, forwardCommit, path.relativePath)
    const digest = forward ? digestBytes(forward) : null
    const expected = { exists: forward !== null, digest }
    if (
      presenceChanged(expected, path.head) ||
      presenceChanged(expected, path.stage) ||
      presenceChanged(expected, path.worktree)
    ) {
      drifted.push(path.relativePath)
    }
  }
  return drifted
}

interface LoadedChange {
  readonly relativePath: string
  readonly action: 'add' | 'modify' | 'delete'
  readonly bytes?: Uint8Array
}

async function loadChanges(
  root: string,
  revisionRef: string,
  changes: readonly VersionLimitedChange[]
): Promise<LoadedChange[]> {
  const loaded: LoadedChange[] = []
  for (const change of changes) {
    await assertWorkPath(root, change.relativePath)
    const current = await readCommitFile({ dir: root }, revisionRef, change.relativePath)
    if (change.action === 'delete') {
      if (change.retentionRef !== null) throw identityUnfixed()
      if (current) loaded.push({ relativePath: change.relativePath, action: 'delete' })
      continue
    }
    if (!change.retentionRef) throw identityUnfixed()
    const bytes = await readRetainedBlob(root, change.retentionRef)
    if (!current || !bytesEqual(current, bytes)) {
      loaded.push({
        relativePath: change.relativePath,
        action: current ? change.action : 'add',
        bytes
      })
    }
  }
  return loaded
}

async function commitMatchesIntent(
  root: string,
  operationId: string,
  forwardCommitId: string
): Promise<boolean> {
  const technical = await readOperationRecord(root, operationId)
  const stored = await readVersionOperation(root, operationId)
  const retentions = stored?.commitIntent?.retentions
  if (
    technical.kind !== 'ok' ||
    technical.record.forwardCommitId !== forwardCommitId ||
    !retentions
  ) {
    return false
  }
  if (technical.record.paths.length !== retentions.length) return false
  for (const path of technical.record.paths) {
    const retention = retentions.find((item) => item.relativePath === path.relativePath)
    const actionMatches =
      retention?.action === path.action || (retention?.action === 'modify' && path.action === 'add')
    if (!retention || !actionMatches) return false
    if (retention.retentionRef !== null) {
      if (retention.retentionRef !== path.intendedDigest) return false
      continue
    }
    if (path.action === 'delete') {
      if (path.intendedDigest !== null) return false
      continue
    }
    if (!path.intendedDigest) return false
    const published = await readCommitFile({ dir: root }, forwardCommitId, path.relativePath)
    if (!published || digestBytes(published) !== path.intendedDigest) return false
  }
  return true
}

async function fingerprintFor(root: string, operationId: string): Promise<string | null> {
  const stored = await readVersionOperation(root, operationId)
  return stored?.commitIntent?.contentFingerprint ?? null
}

async function ensureRepository(root: string): Promise<boolean> {
  try {
    await assertWorkRepository(root)
    return false
  } catch (error) {
    if (isCode(error, ProjectVersioningErrorCodes.gitNotRepository)) return true
    throw error instanceof AppException
      ? error
      : asGitException(error, ProjectVersioningErrorCodes.gitUnavailable, '作品仓库暂时无法访问')
  }
}

async function createFirstBaseline(
  root: string,
  relativePaths: readonly string[],
  initialize: boolean
): Promise<void> {
  if (initialize) {
    try {
      await git.init({ fs, dir: root, defaultBranch: 'main' })
    } catch (error) {
      throw asGitException(error, ProjectVersioningErrorCodes.gitUnavailable, '作品仓库无法建立')
    }
  }
  for (const relativePath of relativePaths) {
    const absolute = await assertWorkPath(root, relativePath)
    let stats: Awaited<ReturnType<typeof lstat>>
    try {
      stats = await lstat(absolute)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
      throw asGitException(error, ProjectVersioningErrorCodes.gitUnavailable, '作品基线无法建立')
    }
    if (!stats.isFile()) {
      throw new AppException({ code: ErrorCodes.invalidRequest, msg: '基线路径不是文件' })
    }
    try {
      await git.add({ fs, dir: root, filepath: relativePath })
    } catch (error) {
      throw asGitException(error, ProjectVersioningErrorCodes.gitUnavailable, '作品基线无法建立')
    }
  }
  const author = {
    name: 'opengalgame',
    email: 'opengalgame@localhost',
    timestamp: Math.floor(Date.now() / 1000),
    timezoneOffset: new Date().getTimezoneOffset()
  }
  try {
    await git.commit({
      fs,
      dir: root,
      message: '建立作品基线\n',
      author,
      committer: author
    })
  } catch (error) {
    throw asGitException(error, ProjectVersioningErrorCodes.gitUnavailable, '作品基线无法建立')
  }
}

async function ensureDeclaredPathsInside(
  root: string,
  relativePaths: readonly string[],
  effects: GitEffects
): Promise<VersionBaselineFact> {
  const created = await ensureRepository(root)
  let head: { commitId: string } | null = null
  if (!created) {
    try {
      head = await readHead(root)
    } catch (error) {
      if (!isCode(error, ProjectVersioningErrorCodes.gitNoCommits)) throw error
    }
  }
  if (!head) {
    await createFirstBaseline(root, relativePaths, created)
    return factOf(await readHead(root))
  }
  const missing = await missingHeadPaths(root, head.commitId, relativePaths)
  if (missing.length === 0) return factOf(head)
  await supplementBaseline(root, head.commitId, missing, effects)
  return factOf(await readHead(root))
}

async function missingHeadPaths(
  root: string,
  commitId: string,
  relativePaths: readonly string[]
): Promise<string[]> {
  const missing: string[] = []
  for (const relativePath of uniquePaths(relativePaths)) {
    const committed = await readCommitFile({ dir: root }, commitId, relativePath)
    if (committed !== null) continue
    const absolute = await assertWorkPath(root, relativePath)
    let stats: Awaited<ReturnType<typeof lstat>>
    try {
      stats = await lstat(absolute)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
      throw asGitException(error, ProjectVersioningErrorCodes.gitQueryFailed, '作品基线无法核对')
    }
    if (!stats.isFile() || stats.isSymbolicLink()) {
      throw new AppException({ code: ErrorCodes.invalidRequest, msg: '基线路径不是文件' })
    }
    missing.push(relativePath)
  }
  return missing
}

async function supplementBaseline(
  root: string,
  parent: string,
  relativePaths: readonly string[],
  effects: GitEffects
): Promise<void> {
  let commit: Awaited<ReturnType<typeof git.readCommit>>
  try {
    commit = await git.readCommit({ fs, dir: root, oid: parent })
  } catch (error) {
    throw asGitException(error, ProjectVersioningErrorCodes.gitQueryFailed, '作品基线无法核对')
  }
  const edits: TreeEdit[] = []
  for (const relativePath of relativePaths) {
    const absolute = await assertWorkPath(root, relativePath)
    edits.push({ relativePath, action: 'upsert', bytes: await readFile(absolute) })
  }
  const written = await applyTreeEdits({ dir: root }, commit.commit.tree, edits)
  const author = {
    name: 'opengalgame',
    email: 'opengalgame@localhost',
    timestamp: Math.floor(Date.now() / 1000),
    timezoneOffset: new Date().getTimezoneOffset()
  }
  const oid = await effects.writeCommit(root, {
    message: '补充作品基线\n',
    tree: written.treeOid,
    parent: [parent],
    author,
    committer: author
  })
  for (const relativePath of relativePaths) {
    const blob = written.blobs.get(relativePath)
    if (!blob) {
      throw new AppException({
        code: ProjectVersioningErrorCodes.gitQueryFailed,
        msg: '作品基线无法建立'
      })
    }
    await effects.stageBlob(root, relativePath, blob)
  }
  const branch = await readBranchRef(root)
  await effects.updateBranch(root, branch, oid, parent)
}

async function assertWorkPath(root: string, relativePath: string): Promise<string> {
  const safe = assertRelativePath(relativePath)
  let current = root
  for (const part of safe.split('/')) {
    current = join(current, part)
    try {
      const stats = await lstat(current)
      if (stats.isSymbolicLink()) {
        throw new AppException({ code: ErrorCodes.forbidden, msg: '路径超出允许范围' })
      }
    } catch (error) {
      if (error instanceof AppException) throw error
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return resolveContained(root, safe)
      throw asGitException(error, ProjectVersioningErrorCodes.gitQueryFailed, '作品路径无法核对')
    }
  }
  return resolveContained(root, safe)
}

async function changedAtOf(root: string, revisionRef: string): Promise<string> {
  try {
    const commit = await git.readCommit({ fs, dir: root, oid: revisionRef })
    const changedAt = new Date(commit.commit.committer.timestamp * 1000).toISOString()
    if (!CHANGED_AT_PATTERN.test(changedAt)) {
      throw new AppException({
        code: ProjectVersioningErrorCodes.gitQueryFailed,
        msg: '作品版本读取失败'
      })
    }
    return changedAt
  } catch (error) {
    throw asGitException(error, ProjectVersioningErrorCodes.gitQueryFailed, '作品版本读取失败')
  }
}

async function assessQuietly(
  root: string,
  operationId: string
): Promise<OperationCommitState | null> {
  try {
    return await assessOperation(root, operationId)
  } catch {
    return null
  }
}

async function readSettlement(
  root: string,
  operationId: string
): Promise<VersionSettlement | null> {
  const value = await readVersionValue(await settlementPath(root, operationId))
  if (value === null) return null
  const settlement = parseVersionValue(settlementSchema, value)
  if (settlement.operationId !== operationId) {
    throw new AppException({
      code: ProjectVersioningErrorCodes.gitQueryFailed,
      msg: '版本记录无法读取'
    })
  }
  return settlement
}

async function writeSettlement(root: string, settlement: VersionSettlement): Promise<void> {
  parseVersionValue(settlementSchema, settlement)
  await writeVersionValue(await settlementPath(root, settlement.operationId), settlement)
}

function settlementPath(root: string, operationId: string): Promise<string> {
  return versionDocumentPath(root, SETTLEMENT_DIRECTORY, `${operationId}.json`)
}

function factOf(head: { commitId: string }): VersionBaselineFact {
  return { baselineRef: head.commitId, revisionRef: head.commitId }
}

function uniquePaths(paths: readonly string[]): string[] {
  const unique: string[] = []
  for (const path of paths) {
    if (!unique.includes(path)) unique.push(path)
  }
  return unique
}

function presenceChanged(left: ContentPresence, right: ContentPresence): boolean {
  return left.exists !== right.exists || left.digest !== right.digest
}

function baselineConflict(): AppException {
  return new AppException({
    code: ErrorCodes.operationConflict,
    msg: '作品基线或目标文件已变化，已拒绝写入'
  })
}

function identityUnfixed(): AppException {
  return new AppException({
    code: ProjectVersioningErrorCodes.invalidContentFingerprint,
    msg: '内容身份不能固定'
  })
}

function isCode(error: unknown, code: number): boolean {
  return error instanceof AppException && error.code === code
}
