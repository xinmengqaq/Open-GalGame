import * as fs from 'node:fs'
import * as git from 'isomorphic-git'

import {
  restoreForwardFiles,
  restoreRecordedFilesWithBackup,
  verifyCompensationBackup
} from './CommitCompensation'
import { resolveContained } from '../containedPath'
import { decodeBytes, digestBytes } from '../objects/gitContent'
import { asGitException } from '../gitErrors'
import type { GitEffects } from '../gitEffects'
import { applyTreeEdits, readCommitFile } from '../objects/gitTree'
import { readOperationRecord, type OperationRecord } from './OperationRecord'
import {
  assessOperation,
  findPublishedRollback,
  proveRollbackCommit
} from './OperationQuery'
import { readHead } from '../repository/repositoryGuard'
import { readStageOids, readWorkBaseline, readWorktreeBytes } from '../repository/WorkBaseline'
import { AppException } from '@common/errors/AppException'
import { ErrorCodes } from '@common/errors/ErrorCodes'
import { ProjectVersioningErrorCodes } from '@domain/project-versioning/errors/ProjectVersioningErrorCodes'

export async function rollbackLimited(
  projectRoot: string,
  operationId: string,
  effects: GitEffects,
  options?: { readonly backupBeforeRestore?: boolean }
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
  let record = read.record
  const resumed = await finishPublishedRollback(projectRoot, record, effects)
  if (resumed) return resumed
  const backupBeforeRestore = options?.backupBeforeRestore === true
  if (!backupBeforeRestore) await assertNoLaterEdits(projectRoot, record)
  const head = await readHead(projectRoot)
  if (!head.branch) {
    throw new AppException({
      code: ProjectVersioningErrorCodes.gitQueryFailed,
      msg: '作品仓库处于分离头指针，无法发布提交'
    })
  }
  const branchRef = `refs/heads/${head.branch}`
  const paths = record.paths.map((path) => path.relativePath)
  const stageBefore = await readStageOids(projectRoot, paths)
  const appliedStageOids = new Map<string, string | null>()
  try {
    let written: { treeOid: string }
    if (backupBeforeRestore) {
      if (record.rollbackBackupId) {
        await verifyCompensationBackup(projectRoot, record, record.rollbackBackupId)
      }
      await restoreRecordedFilesWithBackup(projectRoot, record, effects, {
        mode: 'rollback',
        restoreStage: false
      })
      const refreshed = await readOperationRecord(projectRoot, operationId)
      if (refreshed.kind !== 'ok') {
        throw new AppException({
          code: ProjectVersioningErrorCodes.gitQueryFailed,
          msg: '回退恢复记录无法读取'
        })
      }
      record = refreshed.record
      written = await buildRollbackTree(
        projectRoot,
        record,
        head.commitId,
        effects,
        appliedStageOids
      )
    } else {
      record = await mark(projectRoot, record, { phase: 'rollback-required' }, effects)
      written = await restoreWorktree(
        projectRoot,
        record,
        head.commitId,
        effects,
        appliedStageOids
      )
    }
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
    if (!backupBeforeRestore) {
      await compensateRollback(
        projectRoot,
        record,
        head.commitId,
        stageBefore,
        appliedStageOids,
        effects,
        error
      )
    }
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
    if (original === null) await effects.removeFile(absolute)
    else await effects.writeBytes(absolute, original)
  }
  return buildRollbackTree(projectRoot, record, headOid, effects, appliedStageOids)
}

async function buildRollbackTree(
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
    const original =
      path.originalBytesBase64 === null ? null : decodeBytes(path.originalBytesBase64)
    if (path.originalBytesBase64 !== null && !original) {
      throw new AppException({
        code: ProjectVersioningErrorCodes.gitQueryFailed,
        msg: '提交前的原始字节无法还原'
      })
    }
    edits.push(
      original === null
        ? { relativePath: path.relativePath, action: 'delete' }
        : { relativePath: path.relativePath, action: 'upsert', bytes: original }
    )
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
  const forwardCommitId = record.forwardCommitId
  if (!forwardCommitId) return null
  let rollbackCommitId = record.rollbackCommitId
  if (rollbackCommitId) {
    const proof = await proveRollbackCommit(projectRoot, record, rollbackCommitId)
    if (proof.state === 'conflict') {
      throw new AppException({
        code: ProjectVersioningErrorCodes.gitQueryFailed,
        msg: proof.detail
      })
    }
    if (proof.state === 'unpublished') return null
  } else {
    rollbackCommitId = await findPublishedRollback(projectRoot, record)
    if (!rollbackCommitId) return null
  }
  if (record.phase !== 'rolled-back' || record.rollbackCommitId !== rollbackCommitId) {
    record = await mark(
      projectRoot,
      record,
      { phase: 'rolled-back', rollbackCommitId },
      effects
    )
  }
  return { rollbackCommitId }
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
