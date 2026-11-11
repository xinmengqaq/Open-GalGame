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
  VersionTransactionGateway,
  VersionTransactionView
} from '@application/project-versioning/ports/VersionTransactionGateway'
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
import { applyTreeEdits, readCommitFile, type TreeEdit } from '@infrastructure/git/objects/gitTree'
import { writeCandidateRevision } from '@infrastructure/git/objects/writeCandidateRevision'
import { readWorkBaseline } from '@infrastructure/git/repository/WorkBaseline'
import {
  assertWorkRepository,
  readBranchRef,
  readHead
} from '@infrastructure/git/repository/repositoryGuard'
import type { ContentPresence, OperationCommitState } from '@infrastructure/git/GitRepository'
import { commitLimited } from '@infrastructure/git/transaction/LimitedCommit'
import { assessOperation } from '@infrastructure/git/transaction/OperationQuery'
import { readOperationRecord } from '@infrastructure/git/transaction/OperationRecord'
import { rollbackLimited } from '@infrastructure/git/transaction/OperationRollback'
import { enqueueWorkWrite } from '@infrastructure/git/transaction/workWriteBoundary'

import { readRetainedBlob } from './FileVersionContentGateway'
import { readVersionOperation } from './FileVersionOperationRecordGateway'
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
    })
  ])
})

type VersionSettlement = z.infer<typeof settlementSchema>

/**
 * 把共享 Git 事务映射为版本事实。
 * 不重置分支，不改写已有提交，也不覆盖声明内容之外的偏离。
 */
export class GitVersionTransactionGateway implements VersionTransactionGateway {
  constructor(
    private readonly userDirectory: string,
    private readonly effects: GitEffects = realGitEffects
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
    const root = await resolveProjectWorkRoot(this.userDirectory, input.projectId)
    return enqueueWorkWrite(root, () => publishInside(root, input, this.effects))
  }

  async rollback(input: VersionRollbackRequest): Promise<VersionRollbackExecution> {
    requireOperationId(input.operationId)
    const root = await resolveProjectWorkRoot(this.userDirectory, input.projectId)
    return enqueueWorkWrite(root, () => rollbackInside(root, input, this.effects))
  }
}

async function publishInside(
  root: string,
  input: VersionCommitRequest,
  effects: GitEffects
): Promise<VersionCommitExecution> {
  const paths = uniquePaths(input.changes.map((change) => assertRelativePath(change.relativePath)))
  const record = await readVersionOperation(root, input.operationId)
  const scope = uniquePaths([...paths, ...(record?.watchedPaths ?? [])])
  const observation = await observeCommit(root, input.operationId, scope, input.changes)
  const decision = await input.verify(observation)
  if (decision.action === 'reuse') return reuseCommit(root, input.operationId)
  const fresh = await observeCommit(root, input.operationId, scope, input.changes)
  if (fresh.baseline.revisionRef !== input.baselineRef || fresh.subsequentPaths.length > 0) {
    throw baselineConflict()
  }
  const loaded = await loadChanges(root, fresh.baseline.revisionRef, input.changes)
  if (loaded.length === 0) return persistNoChange(root, input)
  try {
    return await publishChanges(root, input, loaded, effects)
  } catch (error) {
    return classifyCommitFailure(root, input, error)
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
  if (fresh.subsequentPaths.length > 0) {
    throw new AppException({
      code: ErrorCodes.operationConflict,
      msg: '目标路径已有后续修改，已拒绝回退'
    })
  }
  try {
    const published = await rollbackLimited(root, input.operationId, effects)
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
  effects: GitEffects
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
    const publishPaths = changes.map((change) => change.relativePath)
    const baseline = await readWorkBaseline(root, publishPaths)
    if (baseline.headCommitId !== input.baselineRef) throw baselineConflict()
    const published = await commitLimited(
      {
        projectRoot: root,
        operationId: input.operationId,
        expectedBaseline: baseline,
        changes: changes.map(({ relativePath, action }) => ({ relativePath, action })),
        candidate: { gitDir, revisionId: revision.revisionId },
        recheck: async (fresh) => {
          if (fresh.headCommitId !== baseline.headCommitId || fresh.branch !== baseline.branch) {
            throw baselineConflict()
          }
        }
      },
      effects
    )
    return rememberCommit(root, input, published.commitId)
  } finally {
    await rm(parent, { recursive: true, force: true })
  }
}

async function classifyCommitFailure(
  root: string,
  input: VersionCommitRequest,
  error: unknown
): Promise<VersionCommitExecution> {
  const state = await assessQuietly(root, input.operationId)
  if (state?.state === 'committed') return rememberCommit(root, input, state.commitId)
  if (!state || state.state === 'unknown' || state.state === 'rollbackRequired') {
    return { state: '待核对' }
  }
  throw error instanceof AppException
    ? error
    : asGitException(error, ProjectVersioningErrorCodes.gitUnavailable, '作品提交失败')
}

async function rememberCommit(
  root: string,
  input: VersionCommitRequest,
  revisionRef: string
): Promise<VersionCommitExecution> {
  const changedAt = await changedAtOf(root, revisionRef)
  await writeSettlement(root, {
    formatVersion: 1,
    operationId: input.operationId,
    contentFingerprint: input.contentFingerprint,
    outcome: { state: '已提交', revisionRef, changedAt }
  })
  return { state: '已提交', revisionRef, changedAt }
}

async function persistNoChange(
  root: string,
  input: VersionCommitRequest
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
  const changedAt = await changedAtOf(root, input.baselineRef)
  await writeSettlement(root, {
    formatVersion: 1,
    operationId: input.operationId,
    contentFingerprint: input.contentFingerprint,
    outcome: { state: '无变更', revisionRef: input.baselineRef, changedAt }
  })
  return { state: '无变更', revisionRef: input.baselineRef, changedAt }
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
  await writeSettlement(root, {
    formatVersion: 1,
    operationId,
    contentFingerprint: fingerprint,
    outcome
  })
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
  await writeSettlement(root, {
    formatVersion: 1,
    operationId,
    contentFingerprint: fingerprint,
    outcome
  })
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

async function observeCommit(
  root: string,
  operationId: string,
  scope: readonly string[],
  changes: readonly VersionLimitedChange[]
): Promise<{
  baseline: VersionBaselineFact
  subsequentPaths: readonly string[]
  transaction: VersionTransactionView | null
}> {
  const head = await readHead(root)
  const subsequentPaths =
    scope.length === 0 ? [] : await pathsDriftedFromDeclaration(root, scope, changes)
  return {
    baseline: factOf(head),
    subsequentPaths,
    transaction: await readTransactionAt(root, operationId)
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

/**
 * 相对当前修订有差异，且不是本次声明内容的路径。
 * 声明路径会按保留字节重新读取；一致时允许发布，提交期间被换成别的字节则拒绝。
 */
async function pathsDriftedFromDeclaration(
  root: string,
  scope: readonly string[],
  changes: readonly VersionLimitedChange[]
): Promise<string[]> {
  const baseline = await readWorkBaseline(root, scope)
  const declared: Record<string, VersionLimitedChange> = {}
  for (const change of changes) declared[assertRelativePath(change.relativePath)] = change
  const drifted: string[] = []
  for (const path of baseline.paths) {
    if (!presenceChanged(path.head, path.stage) && !presenceChanged(path.head, path.worktree)) {
      continue
    }
    const change = declared[path.relativePath]
    if (change && (await matchesDeclaredContent(root, path, change))) continue
    drifted.push(path.relativePath)
  }
  return drifted
}

async function matchesDeclaredContent(
  root: string,
  path: {
    readonly head: ContentPresence
    readonly stage: ContentPresence
    readonly worktree: ContentPresence
  },
  change: VersionLimitedChange
): Promise<boolean> {
  if (change.action === 'delete') {
    if (change.retentionRef !== null) throw identityUnfixed()
    const stageSafe = !presenceChanged(path.head, path.stage) || !path.stage.exists
    return !path.worktree.exists && stageSafe
  }
  if (!change.retentionRef) throw identityUnfixed()
  const bytes = await readRetainedBlob(root, change.retentionRef)
  const expected = { exists: true, digest: digestBytes(bytes) }
  if (presenceChanged(expected, path.worktree)) return false
  return !presenceChanged(path.head, path.stage) || !presenceChanged(expected, path.stage)
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
      // 当前修订没有此路径时按新增发布，已落盘的新文件不因修改动作被拒绝。
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
    // 基线没有路径时，修改意图会按新增发布。只认这一种动作改写。
    const actionMatches =
      retention?.action === path.action || (retention?.action === 'modify' && path.action === 'add')
    if (!retention || !actionMatches) return false
    if (retention.retentionRef !== null) {
      if (retention.retentionRef !== path.intendedDigest) return false
      continue
    }
    // 可靠结算后凭据会释放。此时仍须核对已发布内容，不能把空引用当成一致。
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
