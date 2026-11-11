import * as fs from 'node:fs'
import * as git from 'isomorphic-git'

import { restoreForwardFiles } from './CommitCompensation'
import { resolveContained } from '../containedPath'
import { decodeBytes, digestBytes } from '../objects/gitContent'
import { asGitException } from '../gitErrors'
import type { GitEffects } from '../gitEffects'
import { applyTreeEdits, readCommitFile } from '../objects/gitTree'
import { readOperationRecord, type OperationRecord } from './OperationRecord'
import { assessOperation } from './OperationQuery'
import { readHead } from '../repository/repositoryGuard'
import { readStageOids, readWorkBaseline, readWorktreeBytes } from '../repository/WorkBaseline'
import { AppException } from '@common/errors/AppException'
import { ErrorCodes } from '@common/errors/ErrorCodes'
import { ProjectVersioningErrorCodes } from '@domain/project-versioning/errors/ProjectVersioningErrorCodes'

/**
 * 追加一个回退提交，只恢复记录里的路径。不重置分支，不改写已有提交。
 * @returns 回退提交标识。重复回退返回已有提交。
 * @throws {AppException} 目标路径已变化、结果不明或回退失败。补偿失败时同时保留两个原因。
 */
export async function rollbackLimited(
  projectRoot: string,
  operationId: string,
  effects: GitEffects
): Promise<{ rollbackCommitId: string }> {
  const state = await assessOperation(projectRoot, operationId)
  if (state.state === 'rolledBack') return { rollbackCommitId: state.rollbackCommitId }
  if (state.state === 'notCommitted') {
    throw new AppException({
      code: ProjectVersioningErrorCodes.gitQueryFailed,
      msg: '作品提交尚未完成，不能回退'
    })
  }
  if (state.state === 'unknown') {
    throw new AppException({
      code: ProjectVersioningErrorCodes.gitQueryFailed,
      msg: '作品提交结果尚未查明，已保留证据'
    })
  }
  const read = await readOperationRecord(projectRoot, operationId)
  if (read.kind !== 'ok' || !read.record.forwardCommitId) {
    throw new AppException({
      code: ProjectVersioningErrorCodes.gitQueryFailed,
      msg: '作品提交结果尚未查明，已保留证据'
    })
  }
  const resumed = await finishPublishedRollback(projectRoot, read.record, effects)
  if (resumed) return resumed
  await assertNoLaterEdits(projectRoot, read.record)
  const head = await readHead(projectRoot)
  if (!head.branch) {
    throw new AppException({
      code: ProjectVersioningErrorCodes.gitQueryFailed,
      msg: '作品仓库处于分离头指针，无法发布提交'
    })
  }
  const branchRef = `refs/heads/${head.branch}`
  const paths = read.record.paths.map((path) => path.relativePath)
  const stageBefore = await readStageOids(projectRoot, paths)
  let record = await mark(projectRoot, read.record, { phase: 'rollback-required' }, effects)
  const appliedStageOids = new Map<string, string | null>()
  try {
    const written = await restoreWorktree(
      projectRoot,
      record,
      head.commitId,
      effects,
      appliedStageOids
    )
    const author = {
      name: 'opengalgame',
      email: 'opengalgame@localhost',
      timestamp: Math.floor(Date.now() / 1000),
      timezoneOffset: new Date().getTimezoneOffset()
    }
    const rollbackCommitId = await effects.writeCommit(projectRoot, {
      message: `回退作品文件\n\nOperation-Id: ${operationId}\nRollback-Of: ${record.forwardCommitId}\n`,
      tree: written.treeOid,
      parent: [head.commitId],
      author,
      committer: author
    })
    record = await mark(projectRoot, record, { rollbackCommitId }, effects)
    await effects.updateBranch(projectRoot, branchRef, rollbackCommitId, head.commitId)
    await mark(projectRoot, record, { phase: 'rolled-back' }, effects)
    return { rollbackCommitId }
  } catch (error) {
    await compensateRollback(
      projectRoot,
      record,
      head.commitId,
      stageBefore,
      appliedStageOids,
      effects,
      error
    )
    throw asGitException(error, ProjectVersioningErrorCodes.gitUnavailable, '作品回退失败')
  }
}

async function assertNoLaterEdits(projectRoot: string, record: OperationRecord): Promise<void> {
  const paths = record.paths.map((path) => path.relativePath)
  const baseline = await readWorkBaseline(projectRoot, paths)
  for (const path of record.paths) {
    const forward = await readCommitFile(
      { dir: projectRoot },
      record.forwardCommitId!,
      path.relativePath
    )
    const current = await readWorktreeBytes(projectRoot, path.relativePath)
    const original =
      path.originalBytesBase64 === null ? null : decodeBytes(path.originalBytesBase64)
    const state = baseline.paths.find((item) => item.relativePath === path.relativePath)
    const forwardDigest = forward ? digestBytes(forward) : null
    const currentDigest = current ? digestBytes(current) : null
    const originalDigest = original ? digestBytes(original) : null
    const matchesForward = currentDigest === forwardDigest && state?.stage.digest === forwardDigest
    const matchesOriginal =
      currentDigest === originalDigest && state?.stage.digest === originalDigest
    const matchesFileOnly =
      currentDigest === originalDigest && state?.stage.digest === forwardDigest
    const resumable = record.phase === 'rollback-required' && (matchesOriginal || matchesFileOnly)
    if (matchesForward || resumable) continue
    if (record.phase === 'rollback-required') {
      throw new AppException({
        code: ProjectVersioningErrorCodes.gitQueryFailed,
        msg: '回退结果尚未查明，已保留证据'
      })
    }
    throw new AppException({
      code: ErrorCodes.operationConflict,
      msg: '目标文件在提交后已改变，已拒绝回退'
    })
  }
}

async function restoreWorktree(
  projectRoot: string,
  record: OperationRecord,
  headOid: string,
  effects: GitEffects,
  appliedStageOids: Map<string, string | null>
): Promise<{ treeOid: string }> {
  const edits: Array<{
    relativePath: string
    action: 'upsert' | 'delete'
    bytes?: Uint8Array
  }> = []
  for (const path of record.paths) {
    const absolute = await resolveContained(projectRoot, path.relativePath)
    const original =
      path.originalBytesBase64 === null ? null : decodeBytes(path.originalBytesBase64)
    if (path.originalBytesBase64 !== null && !original) {
      throw new AppException({
        code: ProjectVersioningErrorCodes.gitQueryFailed,
        msg: '提交前的原始字节无法还原'
      })
    }
    if (original === null) {
      await effects.removeFile(absolute)
      edits.push({ relativePath: path.relativePath, action: 'delete' })
      continue
    }
    await effects.writeBytes(absolute, original)
    edits.push({ relativePath: path.relativePath, action: 'upsert', bytes: original })
  }
  const written = await applyTreeEdits(
    { dir: projectRoot },
    (await git.readCommit({ fs, dir: projectRoot, oid: headOid })).commit.tree,
    edits
  )
  for (const edit of edits) {
    if (!written.blobs.has(edit.relativePath)) {
      throw new AppException({
        code: ProjectVersioningErrorCodes.gitQueryFailed,
        msg: '作品提交树无法生成'
      })
    }
    const oid = written.blobs.get(edit.relativePath) ?? null
    appliedStageOids.set(edit.relativePath, oid)
    await effects.stageBlob(projectRoot, edit.relativePath, oid)
  }
  return { treeOid: written.treeOid }
}

async function finishPublishedRollback(
  projectRoot: string,
  record: OperationRecord,
  effects: GitEffects
): Promise<{ rollbackCommitId: string } | null> {
  if (record.phase !== 'rollback-required' || !record.rollbackCommitId) return null
  const head = await readHead(projectRoot)
  if (head.commitId !== record.rollbackCommitId) return null
  await mark(projectRoot, record, { phase: 'rolled-back' }, effects)
  return { rollbackCommitId: record.rollbackCommitId }
}

async function compensateRollback(
  projectRoot: string,
  record: OperationRecord,
  headBefore: string,
  stageBefore: ReadonlyMap<string, string | null>,
  appliedStageOids: ReadonlyMap<string, string | null>,
  effects: GitEffects,
  error: unknown
): Promise<void> {
  const head = await git
    .resolveRef({ fs, dir: projectRoot, ref: 'HEAD' })
    .catch((readError: unknown) => {
      throw new AppException({
        code: ErrorCodes.internalError,
        msg: '作品回退失败，且无法核对当前提交',
        cause: new AggregateError([error, readError], '回退与补偿失败')
      })
    })
  if (head !== headBefore) return
  try {
    const forwardFiles: Array<{ relativePath: string; bytes: Uint8Array | null }> = []
    for (const path of record.paths) {
      forwardFiles.push({
        relativePath: path.relativePath,
        bytes: await readCommitFile(
          { dir: projectRoot },
          record.forwardCommitId!,
          path.relativePath
        )
      })
    }
    await restoreForwardFiles(
      projectRoot,
      record,
      forwardFiles,
      stageBefore,
      appliedStageOids,
      effects
    )
  } catch (compensationError) {
    throw new AppException({
      code: ErrorCodes.internalError,
      msg: '作品回退失败，且恢复正式文件也失败',
      cause: new AggregateError([error, compensationError], '回退与补偿失败')
    })
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
