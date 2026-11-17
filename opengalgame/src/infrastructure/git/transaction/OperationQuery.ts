import * as fs from 'node:fs'
import * as git from 'isomorphic-git'

import { bytesEqual, decodeBytes, digestBytes } from '../objects/gitContent'
import { asGitException } from '../gitErrors'
import { isReachableFromHead, readCommitFile, resolveRefIfExists } from '../objects/gitTree'
import { operationRef, readOperationRecord, type OperationRecord } from './OperationRecord'
import { assertWorkRepository, readHead } from '../repository/repositoryGuard'
import { readStageOids, readWorktreeBytes } from '../repository/WorkBaseline'
import type { OperationCommitState } from '../GitRepository'
import { AppException } from '@common/errors/AppException'
import { ProjectVersioningErrorCodes } from '@domain/project-versioning/errors/ProjectVersioningErrorCodes'

/** 只读发布证明。引用、阶段和结算缺失不阻断，只以记录、历史和提交内容为准。 */
export type PublishedCommitProof =
  | { readonly state: 'committed'; readonly commitId: string }
  | { readonly state: 'notCommitted' }
  | { readonly state: 'conflict'; readonly detail: string }

/** 只读回退提交证明。未进入 HEAD 历史但内容自洽时区分未发布。 */
export type RollbackCommitProof =
  | { readonly state: 'published'; readonly rollbackCommitId: string }
  | { readonly state: 'unpublished'; readonly rollbackCommitId: string }
  | { readonly state: 'conflict'; readonly detail: string }

/**
 * 只根据磁盘上的记录、引用、历史和文件判断操作状态。
 * @returns 未提交、已提交、需要回退、已回退或真正证据不足。
 * @throws {AppException} 仓库本身无法读取，或引用、提交、内容已经确定冲突。
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
    if (refOid !== null) conflict('存在操作引用但没有提交记录')
    return { state: 'notCommitted' }
  }
  const record = read.record
  if (record.phase === 'compensated') {
    return assessCompensated(projectRoot, record, refOid)
  }
  if (record.forwardCommitId && !(await commitExists(projectRoot, record.forwardCommitId))) {
    conflict('提交对象缺失')
  }
  if (refOid !== null && record.forwardCommitId !== null && refOid !== record.forwardCommitId) {
    conflict('提交记录与引用不一致')
  }
  if (record.phase === 'rolled-back') return assessRolledBack(projectRoot, record)
  if (record.phase === 'rollback-required' && record.forwardCommitId) {
    const rollbackCommitId = record.rollbackCommitId
    if (rollbackCommitId) {
      const proof = await proveRollbackCommit(projectRoot, record, rollbackCommitId)
      if (proof.state === 'conflict') conflict(proof.detail)
      if (proof.state === 'published') {
        return {
          state: 'rolledBack',
          commitId: record.forwardCommitId,
          rollbackCommitId
        }
      }
    }
    return { state: 'rollbackRequired', commitId: record.forwardCommitId }
  }
  const proof = await provePublishedRecord(projectRoot, record, refOid)
  if (proof.state === 'committed') return { state: 'committed', commitId: proof.commitId }
  if (proof.state === 'conflict') conflict(proof.detail)
  if (
    (await alignsWithOriginal(projectRoot, record)) &&
    refOid === null &&
    !(await forwardInHistory(projectRoot, record))
  ) {
    return { state: 'notCommitted' }
  }
  return { state: 'unknown', detail: '正式文件已改变但提交尚未发布，或证据互相矛盾' }
}

function conflict(detail: string): never {
  throw new AppException({
    code: ProjectVersioningErrorCodes.gitQueryFailed,
    msg: detail
  })
}

/**
 * 证明操作已经正式发布。
 * 操作引用、记录阶段和结算只是派生证据；引用缺失不阻断，引用冲突或提交内容不符报告冲突。
 * @throws {AppException} 仓库本身无法读取。
 */
export async function provePublishedOperation(
  projectRoot: string,
  operationId: string
): Promise<PublishedCommitProof> {
  await assertWorkRepository(projectRoot)
  const read = await readOperationRecord(projectRoot, operationId)
  const refOid = await resolveRefIfExists({ dir: projectRoot }, operationRef(operationId))
  if (read.kind === 'damaged') return { state: 'conflict', detail: '提交记录损坏' }
  if (read.kind === 'missing') {
    return refOid === null
      ? { state: 'notCommitted' }
      : { state: 'conflict', detail: '存在操作引用但没有提交记录' }
  }
  return provePublishedRecord(projectRoot, read.record, refOid)
}

async function assessCompensated(
  projectRoot: string,
  record: OperationRecord,
  refOid: string | null
): Promise<OperationCommitState> {
  if (refOid !== null) conflict('补偿记录仍存在操作引用')
  if (!record.forwardCommitId) return { state: 'notCommitted' }
  if (!(await commitExists(projectRoot, record.forwardCommitId))) {
    conflict('补偿记录的前向提交对象缺失')
  }
  if (await forwardInHistory(projectRoot, record)) {
    conflict('补偿记录的前向提交已在当前历史中')
  }
  return { state: 'notCommitted' }
}

async function assessRolledBack(
  projectRoot: string,
  record: OperationRecord
): Promise<OperationCommitState> {
  const forwardCommitId = record.forwardCommitId
  const rollbackCommitId = record.rollbackCommitId
  if (!forwardCommitId) {
    conflict('回退记录缺少前向提交标识')
  }
  if (!rollbackCommitId) {
    conflict('回退记录缺少回退提交标识')
  }
  const proof = await proveRollbackCommit(projectRoot, record, rollbackCommitId)
  if (proof.state === 'conflict') conflict(proof.detail)
  if (proof.state === 'unpublished') conflict('回退提交不在当前历史中')
  return {
    state: 'rolledBack',
    commitId: forwardCommitId,
    rollbackCommitId
  }
}

/**
 * 在 HEAD 历史中找出已经发布、但记录缺失的回退提交。
 * 候选必须通过统一回退证明；只读取提交对象，不回写，冲突直接硬错误。
 */
export async function findPublishedRollback(
  projectRoot: string,
  record: OperationRecord
): Promise<string | null> {
  const forwardCommitId = record.forwardCommitId
  if (!forwardCommitId) return null
  const entries = await git.log({ fs, dir: projectRoot, ref: 'HEAD' })
  for (const entry of entries) {
    const commit = await git.readCommit({ fs, dir: projectRoot, oid: entry.oid })
    const lines = commit.commit.message.split(/\r?\n/u)
    if (
      !lines.includes(`Operation-Id: ${record.operationId}`) ||
      !lines.includes(`Rollback-Of: ${forwardCommitId}`)
    ) {
      continue
    }
    const proof = await proveRollbackCommit(projectRoot, record, entry.oid)
    if (proof.state === 'conflict') conflict(proof.detail)
    if (proof.state === 'published') return entry.oid
  }
  return null
}

/**
 * 校验一个候选回退提交：操作身份、前向提交、父祖先、恢复路径和无关路径。
 * @throws {AppException} 仓库对象无法读取。
 */
export async function proveRollbackCommit(
  projectRoot: string,
  record: OperationRecord,
  rollbackCommitId: string
): Promise<RollbackCommitProof> {
  const forwardCommitId = record.forwardCommitId
  if (!forwardCommitId) {
    return { state: 'conflict', detail: '回退记录缺少前向提交标识' }
  }
  if (!(await commitExists(projectRoot, forwardCommitId))) {
    return { state: 'conflict', detail: '前向提交对象缺失' }
  }
  let forwardMessage: string
  try {
    forwardMessage = (
      await git.readCommit({ fs, dir: projectRoot, oid: forwardCommitId })
    ).commit.message
  } catch {
    return { state: 'conflict', detail: '前向提交对象缺失' }
  }
  if (!hasCommitLine(forwardMessage, 'Operation-Id', record.operationId)) {
    return { state: 'conflict', detail: '前向提交身份与操作不一致' }
  }
  if (!(await commitMatchesIntended(projectRoot, record))) {
    return { state: 'conflict', detail: '前向提交内容与操作记录不一致' }
  }

  let rollback: Awaited<ReturnType<typeof git.readCommit>>
  try {
    rollback = await git.readCommit({ fs, dir: projectRoot, oid: rollbackCommitId })
  } catch {
    return { state: 'conflict', detail: '回退提交对象缺失' }
  }
  if (!hasCommitLine(rollback.commit.message, 'Operation-Id', record.operationId)) {
    return { state: 'conflict', detail: '回退提交身份与操作不一致' }
  }
  if (!hasCommitLine(rollback.commit.message, 'Rollback-Of', forwardCommitId)) {
    return { state: 'conflict', detail: '回退提交与前向提交不对应' }
  }
  if (rollback.commit.parent.length !== 1) {
    return { state: 'conflict', detail: '回退提交父提交不唯一' }
  }
  const parent = rollback.commit.parent[0]
  if (!(await isCommitAncestor(projectRoot, forwardCommitId, parent))) {
    return { state: 'conflict', detail: '回退提交父提交不基于前向提交' }
  }

  for (const path of record.paths) {
    const expected =
      path.originalBytesBase64 === null ? null : decodeBytes(path.originalBytesBase64)
    if (path.originalBytesBase64 !== null && expected === null) {
      return { state: 'conflict', detail: '操作记录原始字节无法读取' }
    }
    const actual = await readCommitFile(
      { dir: projectRoot },
      rollbackCommitId,
      path.relativePath
    )
    if (expected === null) {
      if (actual !== null) {
        return { state: 'conflict', detail: `回退提交未删除原始不存在的路径: ${path.relativePath}` }
      }
    } else if (actual === null || !bytesEqual(actual, expected)) {
      return { state: 'conflict', detail: `回退提交内容与原始字节不一致: ${path.relativePath}` }
    }
  }

  const changed = await changedFilesBetween(projectRoot, parent, rollbackCommitId)
  const allowed = new Set(record.paths.map((path) => path.relativePath))
  for (const path of changed) {
    if (!allowed.has(path)) {
      return { state: 'conflict', detail: `回退提交改动了无关路径: ${path}` }
    }
  }

  const published = await isReachableFromHead(projectRoot, rollbackCommitId)
  return published
    ? { state: 'published', rollbackCommitId }
    : { state: 'unpublished', rollbackCommitId }
}

function hasCommitLine(message: string, label: string, value: string): boolean {
  return message.split(/\r?\n/u).includes(`${label}: ${value}`)
}

async function isCommitAncestor(
  projectRoot: string,
  ancestor: string,
  descendant: string
): Promise<boolean> {
  if (ancestor === descendant) return true
  try {
    return await git.isDescendent({
      fs,
      dir: projectRoot,
      oid: descendant,
      ancestor,
      depth: -1
    })
  } catch {
    return false
  }
}

async function changedFilesBetween(
  projectRoot: string,
  beforeRef: string,
  afterRef: string
): Promise<string[]> {
  const changed = await git.walk({
    fs,
    dir: projectRoot,
    trees: [git.TREE({ ref: beforeRef }), git.TREE({ ref: afterRef })],
    map: async (filepath, [before, after]) => {
      if (!before && !after) return
      if (
        (before && (await before.type()) === 'tree') ||
        (after && (await after.type()) === 'tree')
      ) {
        return
      }
      const beforeOid = before ? await before.oid() : null
      const afterOid = after ? await after.oid() : null
      return beforeOid === afterOid ? undefined : filepath
    }
  })
  return changed.filter((path): path is string => path !== undefined)
}

async function provePublishedRecord(
  projectRoot: string,
  record: OperationRecord,
  refOid: string | null
): Promise<PublishedCommitProof> {
  if (record.phase === 'rolled-back' || record.phase === 'rollback-required') {
    return { state: 'conflict', detail: '操作处于回退阶段，不能认领前向提交' }
  }
  if (!record.forwardCommitId) {
    return refOid === null
      ? { state: 'notCommitted' }
      : { state: 'conflict', detail: '存在操作引用但没有前向提交记录' }
  }
  if (refOid !== null && refOid !== record.forwardCommitId) {
    return { state: 'conflict', detail: '提交记录与引用不一致' }
  }
  if (!(await commitExists(projectRoot, record.forwardCommitId))) {
    return { state: 'conflict', detail: '提交对象缺失' }
  }
  if (!(await forwardInHistory(projectRoot, record))) {
    if (refOid !== null) {
      return { state: 'conflict', detail: '提交不在当前历史中' }
    }
    const head = await readHead(projectRoot)
    return head.commitId === record.baselineCommitId
      ? { state: 'notCommitted' }
      : { state: 'conflict', detail: '提交不在当前历史中' }
  }
  let message = ''
  try {
    const commit = await git.readCommit({ fs, dir: projectRoot, oid: record.forwardCommitId })
    message = commit.commit.message
  } catch (error) {
    throw asGitException(error, ProjectVersioningErrorCodes.gitQueryFailed, '作品提交对象无法读取')
  }
  if (!message.includes(`Operation-Id: ${record.operationId}`)) {
    return { state: 'conflict', detail: '提交消息与操作不一致' }
  }
  if (!(await commitMatchesIntended(projectRoot, record))) {
    return { state: 'conflict', detail: '提交内容与操作记录不一致' }
  }
  return { state: 'committed', commitId: record.forwardCommitId }
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
    if (path.action === 'delete' && path.intendedDigest !== null) return false
    if (path.action !== 'delete' && path.intendedDigest === null) return false
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
