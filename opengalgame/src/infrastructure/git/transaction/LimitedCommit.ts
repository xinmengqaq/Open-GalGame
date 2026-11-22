import * as fs from 'node:fs'
import * as git from 'isomorphic-git'

import { restoreRecordedFiles } from './CommitCompensation'
import { resolveContained } from '../containedPath'
import { bytesEqual, decodeBytes, digestBytes, encodeBytes } from '../objects/gitContent'
import { asGitException } from '../gitErrors'
import type { GitEffects } from '../gitEffects'
import {
  applyTreeEdits,
  isReachableFromHead,
  readCommitFile,
  resolveRefIfExists
} from '../objects/gitTree'
import {
  fingerprintChanges,
  indexEvidence,
  operationRef,
  readOperationRecord,
  type OperationRecord
} from './OperationRecord'
import {
  assessOperation,
  provePublishedOperation,
  type PublishedCommitProof
} from './OperationQuery'
import { readHead } from '../repository/repositoryGuard'
import {
  baselinesMatch,
  readIndexBytes,
  readStageOids,
  readWorkBaseline,
  readWorktreeBytes
} from '../repository/WorkBaseline'
import type { LimitedCommitRequest, WorkPathChange } from '../GitRepository'
import { AppException } from '@common/errors/AppException'
import { ErrorCodes } from '@common/errors/ErrorCodes'
import { ProjectVersioningErrorCodes } from '@domain/project-versioning/errors/ProjectVersioningErrorCodes'

interface LoadedChange extends WorkPathChange {
  readonly bytes?: Uint8Array
  readonly intendedDigest: string | null
}

export async function commitLimited(
  request: LimitedCommitRequest,
  effects: GitEffects
): Promise<{ commitId: string }> {
  assertChanges(request.changes)
  const loaded = await loadCandidate(request)
  const fingerprint = fingerprintChanges(loaded)
  const existing = await readOperationRecord(request.projectRoot, request.operationId)
  if (existing.kind === 'damaged') throw unknownResult()
  if (existing.kind === 'ok' && existing.record.fingerprint !== fingerprint) {
    throw new AppException({
      code: ErrorCodes.operationConflict,
      msg: '同一操作标识对应的请求内容不一致'
    })
  }
  if (existing.kind === 'ok') {
    const state = await assessOperation(request.projectRoot, request.operationId)
    if (state.state === 'committed') return { commitId: state.commitId }
    if (state.state !== 'notCommitted') throw unknownResult()
  }
  const fresh = await readWorkBaseline(
    request.projectRoot,
    request.expectedBaseline.paths.map((path) => path.relativePath)
  )
  if (!baselinesMatch(request.expectedBaseline, fresh)) {
    throw new AppException({
      code: ErrorCodes.operationConflict,
      msg: '作品基线或目标文件已变化，已拒绝写入'
    })
  }
  await runRecheck(request, fresh)
  const confirmed = await readWorkBaseline(
    request.projectRoot,
    request.expectedBaseline.paths.map((path) => path.relativePath)
  )
  if (!baselinesMatch(request.expectedBaseline, confirmed)) {
    throw new AppException({
      code: ErrorCodes.operationConflict,
      msg: '作品基线或目标文件已变化，已拒绝写入'
    })
  }
  if (!confirmed.branch) {
    throw new AppException({
      code: ProjectVersioningErrorCodes.gitQueryFailed,
      msg: '作品仓库处于分离头指针，无法发布提交'
    })
  }
  assertActions(confirmed, loaded)
  const branchRef = `refs/heads/${confirmed.branch}`
  let record =
    existing.kind === 'ok'
      ? existing.record
      : await beginRecord(request, loaded, fingerprint, effects)
  if (record.baselineCommitId !== confirmed.headCommitId) {
    if (request.advanceBaseline !== true || !canAdvanceBaseline(record)) throw baselineConflict()
    record = await mark(
      request.projectRoot,
      record,
      { baselineCommitId: confirmed.headCommitId, branch: confirmed.branch },
      effects
    )
  }
  const appliedStageOids = new Map<string, string | null>()
  try {
    await applyWorktree(request.projectRoot, record, loaded, effects)
    record = await mark(request.projectRoot, record, { phase: 'files-applied' }, effects)
    const written = await applyTreeEdits(
      { dir: request.projectRoot },
      (await git.readCommit({ fs, dir: request.projectRoot, oid: record.baselineCommitId })).commit
        .tree,
      loaded.map((change) => ({
        relativePath: change.relativePath,
        action: change.action === 'delete' ? 'delete' : 'upsert',
        bytes: change.bytes
      }))
    )
    for (const change of loaded) {
      if (!written.blobs.has(change.relativePath)) {
        throw new AppException({
          code: ProjectVersioningErrorCodes.gitQueryFailed,
          msg: '作品提交树无法生成'
        })
      }
    }
    record = await mark(
      request.projectRoot,
      record,
      {
        paths: record.paths.map((path) => ({
          ...path,
          intendedStageOid: written.blobs.get(path.relativePath) ?? null
        }))
      },
      effects
    )
    for (const change of loaded) {
      const oid = written.blobs.get(change.relativePath) ?? null
      appliedStageOids.set(change.relativePath, oid)
      await effects.stageBlob(request.projectRoot, change.relativePath, oid)
    }
    record = await mark(request.projectRoot, record, { phase: 'index-updated' }, effects)
    const author = commitAuthor()
    const commitId = await effects.writeCommit(request.projectRoot, {
      message: `更新作品文件\n\nOperation-Id: ${request.operationId}\n`,
      tree: written.treeOid,
      parent: [record.baselineCommitId],
      author,
      committer: author
    })
    record = await mark(
      request.projectRoot,
      record,
      { phase: 'object-written', forwardCommitId: commitId },
      effects
    )
    await effects.updateBranch(request.projectRoot, branchRef, commitId, record.baselineCommitId)
    await effects.writeOperationRef(request.projectRoot, request.operationId, commitId)
    await mark(request.projectRoot, record, { phase: 'published' }, effects)
    return { commitId }
  } catch (error) {
    const proof = await provePublishedOperation(request.projectRoot, request.operationId).catch(
      (proofError: unknown) => {
        throw asGitException(
          proofError,
          ProjectVersioningErrorCodes.gitQueryFailed,
          '提交结果无法核对'
        )
      }
    )
    if (proof.state === 'committed') {
      const repaired = await repairPublishedMetadata(
        request.projectRoot,
        request.operationId,
        effects
      )
      if (repaired === 'conflict') {
        throw new AppException({
          code: ProjectVersioningErrorCodes.gitQueryFailed,
          msg: '提交结果与记录证据冲突'
        })
      }
      return { commitId: proof.commitId }
    }
    if (proof.state === 'conflict') {
      if (
        request.advanceBaseline === true &&
        (await forwardCommitOrphaned(request.projectRoot, record))
      ) {
        await compensateIfUnpublished(
          request.projectRoot,
          record,
          effects,
          appliedStageOids,
          error,
          request.backupBeforeRestore === true
        )
        await mark(request.projectRoot, record, { phase: 'compensated' }, effects)
        throw baselineConflict()
      }
      throw new AppException({
        code: ProjectVersioningErrorCodes.gitQueryFailed,
        msg: proof.detail
      })
    }
    const historyProof = await provePublishedFromHistory(
      request.projectRoot,
      request.operationId,
      record.baselineCommitId,
      loaded
    )
    if (historyProof.state === 'committed') {
      const persisted = await persistPublishedEvidence(
        request.projectRoot,
        record,
        historyProof.commitId,
        effects
      )
      if (persisted === 'conflict') {
        throw new AppException({
          code: ProjectVersioningErrorCodes.gitQueryFailed,
          msg: '提交恢复证据冲突'
        })
      }
      return { commitId: historyProof.commitId }
    }
    if (historyProof.state === 'conflict') {
      throw new AppException({
        code: ProjectVersioningErrorCodes.gitQueryFailed,
        msg: historyProof.detail
      })
    }
    await compensateIfUnpublished(
      request.projectRoot,
      record,
      effects,
      appliedStageOids,
      error,
      request.backupBeforeRestore === true
    )
    if (request.advanceBaseline === true) {
      await mark(request.projectRoot, record, { phase: 'compensated' }, effects)
    }
    throw asGitException(error, ProjectVersioningErrorCodes.gitUnavailable, '作品提交失败')
  }
}

type PublishedMetadataWriteResult = 'repaired' | 'write-failed' | 'conflict'

export async function repairPublishedMetadata(
  projectRoot: string,
  operationId: string,
  effects: GitEffects
): Promise<PublishedMetadataWriteResult> {
  const proof = await provePublishedOperation(projectRoot, operationId).catch(() => null)
  if (!proof || proof.state !== 'committed') return 'conflict'
  const read = await readOperationRecord(projectRoot, operationId).catch(() => null)
  if (!read || read.kind !== 'ok') return 'conflict'
  const current = read.record
  if (current.forwardCommitId !== null && current.forwardCommitId !== proof.commitId) {
    return 'conflict'
  }
  if (current.phase === 'rolled-back' || current.phase === 'rollback-required') {
    return 'conflict'
  }
  let ref: string | null = null
  try {
    ref = await resolveRefIfExists({ dir: projectRoot }, operationRef(operationId))
  } catch {
    return 'conflict'
  }
  if (ref !== null && ref !== proof.commitId) return 'conflict'
  try {
    if (ref === null) {
      await effects.writeOperationRef(projectRoot, operationId, proof.commitId)
    }
    if (current.phase !== 'published' || current.forwardCommitId !== proof.commitId) {
      await effects.writeRecord(projectRoot, {
        ...current,
        phase: 'published',
        forwardCommitId: proof.commitId
      })
    }
  } catch {
    return 'write-failed'
  }
  return 'repaired'
}

async function provePublishedFromHistory(
  projectRoot: string,
  operationId: string,
  baselineCommitId: string,
  loaded: readonly LoadedChange[]
): Promise<PublishedCommitProof> {
  const head = await readHead(projectRoot)
  const entries = await git.log({ fs, dir: projectRoot }).catch((error: unknown) => {
    throw asGitException(error, ProjectVersioningErrorCodes.gitQueryFailed, '提交历史无法读取')
  })
  let sawOperation = false
  let matched: string | null = null
  for (const entry of entries) {
    if (!entry.commit.message.includes(`Operation-Id: ${operationId}`)) continue
    sawOperation = true
    if (!entry.commit.parent.includes(baselineCommitId)) continue
    if (!(await commitMatchesLoaded(projectRoot, entry.oid, loaded))) continue
    matched = entry.oid
    break
  }
  if (!matched) {
    if (sawOperation) {
      return { state: 'conflict', detail: '提交记录与本次基线或内容不一致' }
    }
    return head.commitId === baselineCommitId
      ? { state: 'notCommitted' }
      : { state: 'conflict', detail: '当前提交已前进，无法证明本次操作未发布' }
  }
  const rolledBack = entries.some((entry) =>
    entry.commit.message.includes(`Rollback-Of: ${matched}`)
  )
  return rolledBack
    ? { state: 'conflict', detail: '本次提交已存在回退提交，不能认领为已发布' }
    : { state: 'committed', commitId: matched }
}

async function commitMatchesLoaded(
  projectRoot: string,
  commitId: string,
  loaded: readonly LoadedChange[]
): Promise<boolean> {
  for (const change of loaded) {
    const bytes = await readCommitFile({ dir: projectRoot }, commitId, change.relativePath)
    const digest = bytes ? digestBytes(bytes) : null
    if (digest !== change.intendedDigest) return false
  }
  return true
}

async function persistPublishedEvidence(
  projectRoot: string,
  record: OperationRecord,
  commitId: string,
  effects: GitEffects
): Promise<PublishedMetadataWriteResult> {
  const current = await readOperationRecord(projectRoot, record.operationId).catch(() => null)
  if (!current || current.kind === 'damaged') return 'conflict'
  let ref: string | null = null
  try {
    ref = await resolveRefIfExists({ dir: projectRoot }, operationRef(record.operationId))
  } catch {
    return 'conflict'
  }
  if (ref !== null && ref !== commitId) return 'conflict'
  let next: OperationRecord
  let shouldWriteRecord = false
  if (current.kind === 'missing') {
    next = { ...record, phase: 'published', forwardCommitId: commitId }
    shouldWriteRecord = true
  } else {
    const existing = current.record
    if (
      existing.operationId !== record.operationId ||
      existing.baselineCommitId !== record.baselineCommitId ||
      existing.fingerprint !== record.fingerprint ||
      (existing.forwardCommitId !== null && existing.forwardCommitId !== commitId)
    ) {
      return 'conflict'
    }
    if (existing.phase === 'rolled-back' || existing.phase === 'rollback-required') {
      return 'conflict'
    }
    next = { ...existing, phase: 'published', forwardCommitId: commitId }
    shouldWriteRecord =
      existing.phase !== 'published' || existing.forwardCommitId !== commitId
  }
  if (shouldWriteRecord) {
    try {
      await effects.writeRecord(projectRoot, next)
    } catch {
      return 'write-failed'
    }
  }
  if (ref !== null) return 'repaired'
  try {
    await effects.writeOperationRef(projectRoot, record.operationId, commitId)
  } catch {
    return 'write-failed'
  }
  return 'repaired'
}

async function beginRecord(
  request: LimitedCommitRequest,
  loaded: readonly LoadedChange[],
  fingerprint: string,
  effects: GitEffects
): Promise<OperationRecord> {
  const stageOids = await readStageOids(
    request.projectRoot,
    loaded.map((change) => change.relativePath)
  )
  const paths: OperationRecord['paths'] = []
  for (const change of loaded) {
    const current = await readWorktreeBytes(request.projectRoot, change.relativePath)
    paths.push({
      relativePath: change.relativePath,
      action: change.action,
      originalBytesBase64: current ? encodeBytes(current) : null,
      intendedDigest: change.intendedDigest,
      originalStageOid: stageOids.get(change.relativePath) ?? null,
      intendedStageOid: null
    })
  }
  const record: OperationRecord = {
    formatVersion: 1,
    operationId: request.operationId,
    sourceModule: request.sourceModule,
    phase: 'prepared',
    baselineCommitId: request.expectedBaseline.headCommitId,
    branch: request.expectedBaseline.branch,
    fingerprint,
    candidateRevisionId: request.candidate.revisionId,
    forwardCommitId: null,
    rollbackCommitId: null,
    paths,
    ...indexEvidence(await readIndexBytes(request.projectRoot))
  }
  await effects.writeRecord(request.projectRoot, record)
  return record
}

async function loadCandidate(request: LimitedCommitRequest): Promise<LoadedChange[]> {
  const ref = `refs/opengalgame/revisions/${request.candidate.revisionId}`
  const resolved = await resolveRefIfExists({ gitdir: request.candidate.gitDir }, ref)
  if (resolved !== request.candidate.revisionId) {
    throw new AppException({
      code: ProjectVersioningErrorCodes.gitQueryFailed,
      msg: '候选修订不存在或已损坏'
    })
  }
  const loaded: LoadedChange[] = []
  for (const change of request.changes) {
    if (change.action === 'delete') {
      loaded.push({ ...change, intendedDigest: null })
      continue
    }
    const bytes = await readCommitFile(
      { gitdir: request.candidate.gitDir },
      request.candidate.revisionId,
      change.relativePath
    )
    if (!bytes) {
      throw new AppException({
        code: ProjectVersioningErrorCodes.gitQueryFailed,
        msg: '候选修订缺少要提交的文件'
      })
    }
    loaded.push({ ...change, bytes, intendedDigest: digestBytes(bytes) })
  }
  return loaded
}

async function applyWorktree(
  projectRoot: string,
  record: OperationRecord,
  loaded: readonly LoadedChange[],
  effects: GitEffects
): Promise<void> {
  for (const path of record.paths) {
    const current = await readWorktreeBytes(projectRoot, path.relativePath)
    const original =
      path.originalBytesBase64 === null ? null : decodeBytes(path.originalBytesBase64)
    if (path.originalBytesBase64 !== null && !original) {
      throw new AppException({
        code: ProjectVersioningErrorCodes.gitQueryFailed,
        msg: '提交前的原始字节无法还原'
      })
    }
    if (!sameBytes(current, original)) {
      throw new AppException({
        code: ErrorCodes.operationConflict,
        msg: '作品基线或目标文件已变化，已拒绝写入'
      })
    }
    const absolute = await resolveContained(projectRoot, path.relativePath)
    if (path.action === 'delete') {
      await effects.removeFile(absolute)
      continue
    }
    const change = loaded.find((item) => item.relativePath === path.relativePath)
    if (!change?.bytes) {
      throw new AppException({
        code: ProjectVersioningErrorCodes.gitQueryFailed,
        msg: '候选修订缺少要提交的文件'
      })
    }
    await effects.writeBytes(absolute, change.bytes)
  }
}

async function mark(
  projectRoot: string,
  record: OperationRecord,
  patch: Partial<OperationRecord>,
  effects: GitEffects
): Promise<OperationRecord> {
  const next = { ...record, ...patch }
  await effects.writeRecord(projectRoot, next)
  return next
}

async function runRecheck(
  request: LimitedCommitRequest,
  fresh: Awaited<ReturnType<typeof readWorkBaseline>>
): Promise<void> {
  try {
    await request.recheck(fresh)
  } catch (error) {
    if (error instanceof AppException) throw error
    throw asGitException(error, ProjectVersioningErrorCodes.gitQueryFailed, '提交前复核失败')
  }
}

async function compensateIfUnpublished(
  projectRoot: string,
  record: OperationRecord,
  effects: GitEffects,
  appliedStageOids: ReadonlyMap<string, string | null>,
  error: unknown,
  backupBeforeRestore: boolean
): Promise<void> {
  try {
    await restoreRecordedFiles(projectRoot, record, effects, appliedStageOids, {
      backupBeforeRestore
    })
  } catch (compensationError) {
    throw new AppException({
      code: ErrorCodes.internalError,
      msg: '作品提交失败，且恢复正式文件也失败',
      cause: new AggregateError([error, compensationError], '提交与补偿失败')
    })
  }
}

function sameBytes(left: Uint8Array | null, right: Uint8Array | null): boolean {
  if (left === null || right === null) return left === right
  return bytesEqual(left, right)
}

function canAdvanceBaseline(record: OperationRecord): boolean {
  return record.phase === 'prepared' || record.phase === 'compensated'
}

async function forwardCommitOrphaned(
  projectRoot: string,
  record: OperationRecord
): Promise<boolean> {
  const commitId = record.forwardCommitId
  if (!commitId) return false
  try {
    await git.readCommit({ fs, dir: projectRoot, oid: commitId })
    return !(await isReachableFromHead(projectRoot, commitId))
  } catch {
    return false
  }
}

function baselineConflict(): AppException {
  return new AppException({
    code: ErrorCodes.operationConflict,
    msg: '作品基线或目标文件已变化，已拒绝写入'
  })
}

function assertChanges(changes: readonly WorkPathChange[]): void {
  if (changes.length === 0) {
    throw new AppException({ code: ErrorCodes.invalidRequest, msg: '没有可提交的路径' })
  }
  const paths = changes.map((change) => change.relativePath)
  if (new Set(paths).size !== paths.length) {
    throw new AppException({ code: ErrorCodes.invalidRequest, msg: '提交路径重复' })
  }
}

function assertActions(
  fresh: Awaited<ReturnType<typeof readWorkBaseline>>,
  changes: readonly LoadedChange[]
): void {
  for (const change of changes) {
    const state = fresh.paths.find((path) => path.relativePath === change.relativePath)
    if (!state) {
      throw new AppException({ code: ErrorCodes.invalidRequest, msg: '提交路径缺少基线核对' })
    }
    if (change.action === 'add' && state.head.exists) {
      throw new AppException({
        code: ProjectVersioningErrorCodes.gitQueryFailed,
        msg: '新增路径已在当前提交中'
      })
    }
    if (change.action !== 'add' && !state.head.exists) {
      throw new AppException({
        code: ProjectVersioningErrorCodes.gitQueryFailed,
        msg: '修改路径不在当前提交中'
      })
    }
  }
}

function unknownResult(): AppException {
  return new AppException({
    code: ProjectVersioningErrorCodes.gitQueryFailed,
    msg: '作品提交结果尚未查明，已保留证据'
  })
}

function commitAuthor(): {
  name: string
  email: string
  timestamp: number
  timezoneOffset: number
} {
  return {
    name: 'opengalgame',
    email: 'opengalgame@localhost',
    timestamp: Math.floor(Date.now() / 1000),
    timezoneOffset: new Date().getTimezoneOffset()
  }
}
