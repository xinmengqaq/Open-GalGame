import { createHash } from 'node:crypto'
import * as fs from 'node:fs'
import * as git from 'isomorphic-git'

import type { ProjectVersioningApplicationService } from '@application/project-versioning/services/ProjectVersioningApplicationService'
import { OPERATION_ID_PATTERN } from '@common/contracts/OperationId'

import { readCommitFile } from '../git/objects/gitTree'
import { readOperationRecord } from '../git/transaction/OperationRecord'
import { readVersionOperation } from '../project-versioning/FileVersionOperationRecordGateway'

const GENERATION_SOURCE_MODULE = 'scene-generation'
const COMMIT_ID_PATTERN = /^[0-9a-f]{40}$/u

export type GenerationCommitVerification =
  | {
      readonly state: 'verified'
      readonly operationId: string
      readonly commitId: string
      readonly savedAtMs: number
    }
  | { readonly state: 'notCommitted' }
  | { readonly state: 'contentMismatch' }

/**
 * 核对一次生成提交能否作为当前场景的导出来源。
 * 只认 scene-generation 来源、场景目标、已结算操作和提交里的入口 blob；
 * 当前正式入口内容必须仍与 blob 一致，不把任意提交或候选快照当授权。
 */
export async function verifyGenerationCommit(params: {
  readonly root: string
  readonly versioning: ProjectVersioningApplicationService
  readonly projectId: string
  readonly sceneId: string
  readonly entryRelativePath: string
  readonly currentEntryDigest: string
  readonly operationId: string
  readonly expectedCommitId?: string
}): Promise<GenerationCommitVerification> {
  if (!OPERATION_ID_PATTERN.test(params.operationId)) return { state: 'notCommitted' }

  const link = await params.versioning
    .readCallerOperation({
      projectId: params.projectId,
      sourceModule: GENERATION_SOURCE_MODULE,
      callerOperationId: params.operationId
    })
    .catch(() => null)
  if (
    !link ||
    link.projectId !== params.projectId ||
    link.callerOperationId !== params.operationId
  ) {
    return { state: 'notCommitted' }
  }

  const record = await readVersionOperation(params.root, link.operationId).catch(() => null)
  if (
    !record ||
    record.projectId !== params.projectId ||
    record.operationId !== link.operationId ||
    record.sourceModule !== GENERATION_SOURCE_MODULE ||
    record.callerOperationId !== params.operationId ||
    !record.targets.some((target) => target.kind === 'scene' && target.id === params.sceneId) ||
    record.changePaths.length !== 1 ||
    record.changePaths[0] !== params.entryRelativePath
  ) {
    return { state: 'notCommitted' }
  }

  const settlement = await params.versioning
    .readOperationSettlement({
      projectId: params.projectId,
      operationId: record.operationId
    })
    .catch(() => null)
  if (
    !settlement ||
    (settlement.state !== '已提交' && settlement.state !== '无变更') ||
    !COMMIT_ID_PATTERN.test(settlement.revisionRef)
  ) {
    return { state: 'notCommitted' }
  }
  if (params.expectedCommitId !== undefined && settlement.revisionRef !== params.expectedCommitId) {
    return { state: 'notCommitted' }
  }
  const commitId = settlement.revisionRef

  const technical = await readOperationRecord(params.root, record.operationId).catch(() => null)
  if (!technical || technical.kind === 'damaged') return { state: 'notCommitted' }
  let intendedDigest: string | null = null
  if (technical.kind === 'missing') {
    if (settlement.state !== '无变更') return { state: 'notCommitted' }
  } else {
    const technicalRecord = technical.record
    if (
      technicalRecord.operationId !== record.operationId ||
      (technicalRecord.sourceModule !== undefined &&
        technicalRecord.sourceModule !== GENERATION_SOURCE_MODULE) ||
      (settlement.state === '已提交' && technicalRecord.forwardCommitId !== commitId) ||
      (technicalRecord.forwardCommitId !== null && technicalRecord.forwardCommitId !== commitId)
    ) {
      return { state: 'notCommitted' }
    }
    const path = technicalRecord.paths[0]
    if (
      technicalRecord.paths.length !== 1 ||
      !path ||
      path.relativePath !== params.entryRelativePath ||
      path.action === 'delete' ||
      path.intendedDigest === null
    ) {
      return { state: 'notCommitted' }
    }
    intendedDigest = path.intendedDigest
  }

  const bytes = await readCommitFile(
    { dir: params.root },
    commitId,
    params.entryRelativePath
  ).catch(() => null)
  if (!bytes) return { state: 'notCommitted' }
  const commitDigest = createHash('sha256').update(bytes).digest('hex')
  if (intendedDigest !== null && intendedDigest !== commitDigest) {
    return { state: 'notCommitted' }
  }
  if (commitDigest !== params.currentEntryDigest) return { state: 'contentMismatch' }

  const commit = await git
    .readCommit({ fs, dir: params.root, oid: commitId })
    .catch(() => null)
  if (!commit) return { state: 'notCommitted' }
  return {
    state: 'verified',
    operationId: params.operationId,
    commitId,
    savedAtMs: commit.commit.committer.timestamp * 1000
  }
}
