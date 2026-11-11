import * as fs from 'node:fs'
import * as git from 'isomorphic-git'

import { restoreRecordedFiles } from './CommitCompensation'
import { resolveContained } from '../containedPath'
import { bytesEqual, decodeBytes, digestBytes, encodeBytes } from '../objects/gitContent'
import { asGitException } from '../gitErrors'
import type { GitEffects } from '../gitEffects'
import { applyTreeEdits, readCommitFile, resolveRefIfExists } from '../objects/gitTree'
import {
  fingerprintChanges,
  indexEvidence,
  readOperationRecord,
  type OperationRecord
} from './OperationRecord'
import { assessOperation } from './OperationQuery'
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

/**
 * 复核基线与候选修订后，只把明确路径写入一次新提交。
 * @param request - 预期基线、路径集合、候选修订和调用方复核。
 * @throws {AppException} 基线变化、内容冲突、结果不明或提交失败。补偿失败时同时保留两个原因。
 */
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
    await compensateIfUnpublished(request.projectRoot, record, effects, appliedStageOids, error)
    throw asGitException(error, ProjectVersioningErrorCodes.gitUnavailable, '作品提交失败')
  }
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
      originalStageOid: stageOids.get(change.relativePath) ?? null
    })
  }
  const record: OperationRecord = {
    formatVersion: 1,
    operationId: request.operationId,
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
  error: unknown
): Promise<void> {
  try {
    await restoreRecordedFiles(projectRoot, record, effects, appliedStageOids)
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
