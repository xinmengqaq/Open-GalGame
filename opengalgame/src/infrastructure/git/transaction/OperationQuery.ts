import * as fs from 'node:fs'
import * as git from 'isomorphic-git'

import { bytesEqual, decodeBytes, digestBytes } from '../objects/gitContent'
import { asGitException } from '../gitErrors'
import { isReachableFromHead, readCommitFile, resolveRefIfExists } from '../objects/gitTree'
import { operationRef, readOperationRecord, type OperationRecord } from './OperationRecord'
import { assertWorkRepository } from '../repository/repositoryGuard'
import { readStageOids, readWorktreeBytes } from '../repository/WorkBaseline'
import type { OperationCommitState } from '../GitRepository'
import { ProjectVersioningErrorCodes } from '@domain/project-versioning/errors/ProjectVersioningErrorCodes'

/**
 * 只根据磁盘上的记录、引用、历史和文件判断操作状态。
 * @returns 未提交、已提交、需要回退、已回退或结果不明。
 * @throws {AppException} 仓库本身无法读取。
 */
export async function assessOperation(
  projectRoot: string,
  operationId: string
): Promise<OperationCommitState> {
  await assertWorkRepository(projectRoot)
  const read = await readOperationRecord(projectRoot, operationId)
  const refOid = await resolveRefIfExists({ dir: projectRoot }, operationRef(operationId))
  if (read.kind === 'damaged') return { state: 'unknown', detail: '提交记录损坏' }
  if (read.kind === 'missing') {
    return refOid === null
      ? { state: 'notCommitted' }
      : { state: 'unknown', detail: '存在操作引用但没有提交记录' }
  }
  const record = read.record
  if (record.forwardCommitId && !(await commitExists(projectRoot, record.forwardCommitId))) {
    return { state: 'unknown', detail: '提交对象缺失' }
  }
  if (refOid !== null && record.forwardCommitId !== null && refOid !== record.forwardCommitId) {
    return { state: 'unknown', detail: '提交记录与引用不一致' }
  }
  if (record.phase === 'rolled-back') return assessRolledBack(projectRoot, record)
  if (record.phase === 'rollback-required' && record.forwardCommitId) {
    return { state: 'rollbackRequired', commitId: record.forwardCommitId }
  }
  if ((await publishedCommit(projectRoot, record, refOid)) && record.forwardCommitId) {
    return { state: 'committed', commitId: record.forwardCommitId }
  }
  if (
    (await alignsWithOriginal(projectRoot, record)) &&
    refOid === null &&
    !(await forwardInHistory(projectRoot, record))
  ) {
    return { state: 'notCommitted' }
  }
  return { state: 'unknown', detail: '正式文件已改变但提交尚未发布，或证据互相矛盾' }
}

async function assessRolledBack(
  projectRoot: string,
  record: OperationRecord
): Promise<OperationCommitState> {
  if (!record.forwardCommitId || !record.rollbackCommitId) {
    return { state: 'unknown', detail: '回退记录缺少提交标识' }
  }
  if (!(await commitExists(projectRoot, record.rollbackCommitId))) {
    return { state: 'unknown', detail: '提交对象缺失' }
  }
  if (!(await isReachableFromHead(projectRoot, record.rollbackCommitId))) {
    return { state: 'unknown', detail: '回退提交不在当前历史中' }
  }
  return {
    state: 'rolledBack',
    commitId: record.forwardCommitId,
    rollbackCommitId: record.rollbackCommitId
  }
}

async function publishedCommit(
  projectRoot: string,
  record: OperationRecord,
  refOid: string | null
): Promise<boolean> {
  if (!record.forwardCommitId || refOid !== record.forwardCommitId) return false
  if (!(await forwardInHistory(projectRoot, record))) return false
  let message = ''
  try {
    const commit = await git.readCommit({ fs, dir: projectRoot, oid: record.forwardCommitId })
    message = commit.commit.message
  } catch (error) {
    throw asGitException(error, ProjectVersioningErrorCodes.gitQueryFailed, '作品提交对象无法读取')
  }
  if (!message.includes(`Operation-Id: ${record.operationId}`)) return false
  return commitMatchesIntended(projectRoot, record)
}

async function forwardInHistory(projectRoot: string, record: OperationRecord): Promise<boolean> {
  if (!record.forwardCommitId) return false
  return isReachableFromHead(projectRoot, record.forwardCommitId)
}

async function commitMatchesIntended(
  projectRoot: string,
  record: OperationRecord
): Promise<boolean> {
  if (!record.forwardCommitId) return false
  for (const path of record.paths) {
    const bytes = await readCommitFile(
      { dir: projectRoot },
      record.forwardCommitId,
      path.relativePath
    )
    const digest = bytes ? digestBytes(bytes) : null
    if (digest !== path.intendedDigest) return false
  }
  return true
}

async function worktreeMatchesOriginal(
  projectRoot: string,
  record: OperationRecord
): Promise<boolean> {
  for (const path of record.paths) {
    const expected =
      path.originalBytesBase64 === null ? null : decodeBytes(path.originalBytesBase64)
    if (path.originalBytesBase64 !== null && !expected) return false
    const current = await readWorktreeBytes(projectRoot, path.relativePath)
    if (!sameBytes(current, expected)) return false
  }
  return true
}

async function alignsWithOriginal(projectRoot: string, record: OperationRecord): Promise<boolean> {
  if (!(await worktreeMatchesOriginal(projectRoot, record))) return false
  try {
    const stageOids = await readStageOids(
      projectRoot,
      record.paths.map((path) => path.relativePath)
    )
    return record.paths.every(
      (path) => (stageOids.get(path.relativePath) ?? null) === path.originalStageOid
    )
  } catch {
    return false
  }
}

async function commitExists(projectRoot: string, oid: string): Promise<boolean> {
  try {
    await git.readCommit({ fs, dir: projectRoot, oid })
    return true
  } catch (error) {
    if (
      error instanceof Error &&
      (error.name === 'NotFoundError' || error.name === 'ObjectTypeError')
    ) {
      return false
    }
    throw asGitException(error, ProjectVersioningErrorCodes.gitQueryFailed, '作品提交对象无法读取')
  }
}

function sameBytes(left: Uint8Array | null, right: Uint8Array | null): boolean {
  if (left === null || right === null) return left === right
  return bytesEqual(left, right)
}
