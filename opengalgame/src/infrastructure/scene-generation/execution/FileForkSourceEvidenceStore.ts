import { createHash } from 'node:crypto'
import * as fs from 'node:fs'
import * as git from 'isomorphic-git'
import { z } from 'zod'

import type { ReadSceneGenerationCheckpointDTO } from '@application/scene-generation/dto/SceneGenerationDTO'
import type {
  SceneGenerationCheckpoint,
  SceneGenerationExecution
} from '@application/scene-generation/models/SceneGenerationExecution'
import type {
  ForkSourceCheckpointKind,
  ForkSourceEvidence,
  ForkSourceRevisionEvidence,
  ForkSourceVerification,
  SceneGenerationForkSourceEvidence
} from '@application/scene-generation/ports/SceneGenerationForkSourceEvidence'
import { AppException } from '@common/errors/AppException'
import { ErrorCodes } from '@common/errors/ErrorCodes'
import type { AiProjectFileSystemImpl } from '@infrastructure/ai/filesystem/AiProjectFileSystemImpl'
import { resolveRefIfExists } from '@infrastructure/git/objects/gitTree'
import { readJsonDocument, writeJsonDocument } from '@infrastructure/storage/jsonDocument'
import {
  ensureStateRoot,
  resolveStatePath
} from '@infrastructure/workflow/checkpoints/checkpointPath'
import { assertWorkflowSegment } from '@infrastructure/workflow/WorkflowIdentity'
import { isPiReviewCheckpointId, piReviewCheckpointId } from '../workflow/piReviewCheckpoint'

const STORAGE_FAILURE = {
  code: ErrorCodes.internalError,
  msg: '分叉来源证据读写失败'
} as const

const EVIDENCE_FILE = 'fork-source.json'
/** 证据已捕获的独立标记；证据文件被删除后仍能区分“新建后被删”和“旧记录从未有”。 */
const EVIDENCE_MARKER_FILE = 'fork-source.captured.json'

/**
 * 分叉来源证据存储。捕获时从权威检查点和 Git 提交读取事实，写入后不再改写；
 * 重开时只按证据、当前分叉身份和不可变修订核对，不读取来源操作当前检查点。
 * 证据与捕获标记都缺失时不自动补证：旧检查点只能证明来源事实，不能证明
 * 这条分叉在捕获机制上线前创建、且创建时选定的就是它。
 */
export class FileForkSourceEvidenceStore implements SceneGenerationForkSourceEvidence {
  constructor(
    private readonly stateRoot: string,
    private readonly files: AiProjectFileSystemImpl,
    /** 旧格式检查点在只读存储里有独立记录；Pi 边界不参与该读取。 */
    private readonly readCheckpoint: (
      request: ReadSceneGenerationCheckpointDTO
    ) => Promise<SceneGenerationCheckpoint>
  ) {}

  async capture(
    execution: SceneGenerationExecution,
    checkpoint: SceneGenerationCheckpoint
  ): Promise<void> {
    const fork = execution.fork
    const request = execution.forkRequest
    const sourceOperationId = fork?.sourceOperationId
    if (!fork || !request || sourceOperationId === undefined)
      throw new AppException({
        code: ErrorCodes.operationConflict,
        msg: '分叉执行缺少来源身份，不能捕获来源证据'
      })
    if (
      fork.projectId !== execution.projectId ||
      fork.sceneId !== execution.sceneId ||
      fork.threadId !== execution.threadId
    )
      throw new AppException({
        code: ErrorCodes.operationConflict,
        msg: '分叉来源与当前操作不在同一场景线程'
      })
    if (fork.branchId === execution.branchId || sourceOperationId === execution.operationId)
      throw new AppException({
        code: ErrorCodes.operationConflict,
        msg: '分叉来源必须来自另一操作与分支'
      })
    if (
      checkpoint.execution.operationId !== sourceOperationId ||
      checkpoint.execution.projectId !== execution.projectId ||
      checkpoint.execution.sceneId !== execution.sceneId ||
      checkpoint.execution.threadId !== execution.threadId ||
      checkpoint.execution.branchId !== fork.branchId
    )
      throw new AppException({
        code: ErrorCodes.operationConflict,
        msg: '来源检查点身份与分叉记录不一致'
      })
    if (checkpoint.view.checkpointId !== fork.checkpointId)
      throw new AppException({
        code: ErrorCodes.operationConflict,
        msg: '来源检查点标识与分叉记录不一致'
      })
    const candidateSnapshotId = checkpoint.candidateSnapshotId
    if (
      candidateSnapshotId === undefined ||
      fork.candidateSnapshotId !== candidateSnapshotId ||
      checkpoint.execution.candidateSnapshotId !== candidateSnapshotId
    )
      throw new AppException({
        code: ErrorCodes.operationConflict,
        msg: '来源候选修订与分叉记录不一致'
      })
    if (checkpoint.view.canFork !== true)
      throw new AppException({
        code: ErrorCodes.operationConflict,
        msg: checkpoint.view.reason ?? '来源检查点当前不能分叉'
      })
    const checkpointKind: ForkSourceCheckpointKind = isPiReviewCheckpointId(fork.checkpointId)
      ? 'pi-review'
      : 'legacy'
    if (
      checkpointKind === 'pi-review' &&
      fork.checkpointId !== piReviewCheckpointId(sourceOperationId, candidateSnapshotId)
    )
      throw new AppException({
        code: ErrorCodes.operationConflict,
        msg: '来源检查点与来源操作、候选修订不一致'
      })
    const inputSnapshotDigest = digestJson(checkpoint.execution.inputSnapshot)
    if (!request.inputChanges && digestJson(execution.inputSnapshot) !== inputSnapshotDigest)
      throw new AppException({
        code: ErrorCodes.operationConflict,
        msg: '分叉输入与来源输入不一致，不能捕获来源证据'
      })
    const revision = await this.revisionFacts(execution, sourceOperationId, candidateSnapshotId)
    const fields: Omit<ForkSourceEvidence, 'digest'> = {
      version: 1 as const,
      operationId: execution.operationId,
      projectId: execution.projectId,
      sceneId: execution.sceneId,
      threadId: execution.threadId,
      sourceOperationId,
      sourceBranchId: checkpoint.execution.branchId,
      checkpointId: fork.checkpointId,
      candidateSnapshotId,
      checkpointKind,
      checkpointDigest: digestJson({
        view: checkpoint.view,
        execution: checkpoint.execution,
        candidateSnapshotId
      }),
      inputSnapshotDigest,
      revision
    }
    const evidence: ForkSourceEvidence = { ...fields, digest: evidenceDigest(fields) }
    const path = await this.documentPath(execution, EVIDENCE_FILE)
    const existingRaw = await readJsonDocument(path, STORAGE_FAILURE)
    if (existingRaw !== null) {
      const existing = parseForkSourceEvidence(existingRaw)
      if (existing === undefined || existing.digest !== evidence.digest)
        throw new AppException({
          code: ErrorCodes.operationConflict,
          msg: '分叉来源证据已存在且不可核对，不能覆盖现场'
        })
      await this.writeCaptureMarker(execution, existing.digest)
      return
    }
    await writeJsonDocument(path, evidence, STORAGE_FAILURE)
    await this.writeCaptureMarker(execution, evidence.digest)
  }

  /** 证据与标记一起建立；证据后删时标记仍能证明它曾经被捕获。 */
  private async writeCaptureMarker(
    execution: SceneGenerationExecution,
    evidenceDigestValue: string
  ): Promise<void> {
    const path = await this.documentPath(execution, EVIDENCE_MARKER_FILE)
    const existingRaw = await readJsonDocument(path, STORAGE_FAILURE)
    if (existingRaw !== null) {
      if (parseForkSourceMarker(existingRaw) !== evidenceDigestValue)
        throw new AppException({
          code: ErrorCodes.operationConflict,
          msg: '分叉来源证据捕获标记不一致，不能覆盖现场'
        })
      return
    }
    await writeJsonDocument(
      path,
      { version: 1, evidenceDigest: evidenceDigestValue },
      STORAGE_FAILURE
    )
  }

  async verify(
    execution: SceneGenerationExecution,
    revisionId?: string
  ): Promise<ForkSourceVerification> {
    let raw: unknown | null
    let markerRaw: unknown | null
    try {
      raw = await readJsonDocument(
        await this.documentPath(execution, EVIDENCE_FILE),
        STORAGE_FAILURE
      )
      markerRaw = await readJsonDocument(
        await this.documentPath(execution, EVIDENCE_MARKER_FILE),
        STORAGE_FAILURE
      )
    } catch {
      return {
        ok: false,
        reason: '分叉来源证据无法读取，已保留现场待核对'
      }
    }
    const markerPresent = markerRaw !== null
    const markerDigest = markerRaw === null ? undefined : parseForkSourceMarker(markerRaw)
    if (markerPresent && markerDigest === undefined)
      return { ok: false, reason: '分叉来源证据捕获标记无法核对，已保留现场待核对' }
    let evidence: ForkSourceEvidence | undefined
    if (raw === null) {
      if (markerPresent)
        return {
          ok: false,
          reason: '分叉来源证据已捕获但文件缺失，不能补证，已保留现场待核对'
        }
      // 双缺无法区分“捕获机制上线前的旧分叉”和“证据与标记都被删除”：
      // 旧检查点只能证明来源事实，不能证明这条分叉何时创建、创建时选了它。
      // 持久 fork 指针本身仍是待证明对象，不能用它自证，因此不自动补证。
      return {
        ok: false,
        reason: '分叉来源证据与捕获标记均缺失，无法证明创建时来源，不能补证，已保留现场待核对'
      }
    } else {
      evidence = parseForkSourceEvidence(raw)
      if (evidence === undefined)
        return { ok: false, reason: '分叉来源证据无法核对，已保留现场待核对' }
      if (markerPresent && markerDigest !== evidence.digest)
        return { ok: false, reason: '分叉来源证据与捕获标记不一致，已保留现场待核对' }
    }
    const issue = evidenceIssue(evidence, execution, revisionId)
    if (issue !== undefined) return { ok: false, reason: issue }
    if (evidence.checkpointKind === 'legacy') {
      try {
        const checkpoint = await this.readCheckpoint({
          projectId: evidence.projectId,
          sceneId: evidence.sceneId,
          threadId: evidence.threadId,
          branchId: evidence.sourceBranchId,
          checkpointId: evidence.checkpointId
        })
        const legacyIssue = legacyCheckpointIssue(evidence, checkpoint)
        if (legacyIssue !== undefined) return { ok: false, reason: legacyIssue }
      } catch {
        return {
          ok: false,
          reason: '旧格式来源检查点无法独立复核，已保留现场待核对'
        }
      }
    }
    try {
      const actual = await this.revisionFacts(
        execution,
        evidence.sourceOperationId,
        evidence.candidateSnapshotId
      )
      if (!sameRevision(actual, evidence.revision))
        return { ok: false, reason: '来源候选修订的不可变事实已变化，已保留现场待核对' }
    } catch {
      return {
        ok: false,
        reason: '来源候选修订无法独立证明，已保留现场待核对'
      }
    }
    return { ok: true, evidence }
  }

  /** 读取候选修订的当前不可变事实；发布引用与提交归属必须都属于来源操作。 */
  private async revisionFacts(
    execution: SceneGenerationExecution,
    sourceOperationId: string,
    revisionId: string
  ): Promise<ForkSourceRevisionEvidence> {
    const location = {
      gitdir: this.files.locateWorkspace({
        projectId: execution.projectId,
        threadId: execution.threadId,
        operationId: sourceOperationId
      }).revisionGitDir
    }
    const published = await resolveRefIfExists(location, `refs/opengalgame/revisions/${revisionId}`)
    if (published !== revisionId)
      throw new AppException({
        code: ErrorCodes.operationConflict,
        msg: '来源候选修订未发布到本线程修订库'
      })
    let commit
    try {
      commit = await git.readCommit({ fs, ...location, oid: revisionId })
    } catch (error) {
      throw new AppException({
        code: ErrorCodes.operationConflict,
        msg: '来源候选修订对象无法读取',
        cause: error
      })
    }
    const owner = commit.commit.message
      .split(/\r?\n/u)
      .find((line) => line.startsWith('Operation-Id:'))
      ?.slice('Operation-Id:'.length)
      .trim()
    if (owner !== sourceOperationId)
      throw new AppException({
        code: ErrorCodes.operationConflict,
        msg: '来源候选修订不属于来源操作'
      })
    return {
      revisionId,
      treeId: commit.commit.tree,
      parentRevisionIds: [...commit.commit.parent]
    }
  }

  private async documentPath(
    execution: SceneGenerationExecution,
    fileName: string
  ): Promise<string> {
    const root = await ensureStateRoot(this.stateRoot)
    return resolveStatePath(
      root,
      `projects/${assertWorkflowSegment(execution.projectId, 'projectId')}/threads/${assertWorkflowSegment(execution.threadId, 'threadId')}/operations/${assertWorkflowSegment(execution.operationId, 'operationId')}/${fileName}`
    )
  }
}

/** 证据自身与当前分叉执行、请求和不可变身份是否一致；不读取来源当前状态。 */
function evidenceIssue(
  evidence: ForkSourceEvidence,
  execution: SceneGenerationExecution,
  revisionId: string | undefined
): string | undefined {
  if (evidence.operationId !== execution.operationId) return '分叉来源证据不属于当前操作'
  if (
    evidence.projectId !== execution.projectId ||
    evidence.sceneId !== execution.sceneId ||
    evidence.threadId !== execution.threadId
  )
    return '分叉来源证据与当前场景线程不一致'
  const fork = execution.fork
  const request = execution.forkRequest
  if (!fork || fork.sourceOperationId === undefined) return '分叉执行缺少来源身份'
  if (
    fork.projectId !== evidence.projectId ||
    fork.sceneId !== evidence.sceneId ||
    fork.threadId !== evidence.threadId ||
    evidence.sourceOperationId !== fork.sourceOperationId ||
    evidence.sourceBranchId !== fork.branchId ||
    evidence.checkpointId !== fork.checkpointId ||
    evidence.candidateSnapshotId !== fork.candidateSnapshotId
  )
    return '分叉来源证据与持久分叉记录不一致'
  if (evidence.sourceOperationId === execution.operationId) return '分叉来源不能是当前操作'
  if (evidence.sourceBranchId === execution.branchId) return '分叉来源必须位于另一分支'
  if (evidence.revision.revisionId !== evidence.candidateSnapshotId)
    return '来源候选修订证据与候选标识不一致'
  if (
    evidence.checkpointKind === 'pi-review' &&
    evidence.checkpointId !==
      piReviewCheckpointId(evidence.sourceOperationId, evidence.candidateSnapshotId)
  )
    return 'Pi 来源检查点与来源操作、候选修订不一致'
  if (revisionId !== undefined && evidence.candidateSnapshotId !== revisionId)
    return '待证明的父修订不是创建分叉时复制的来源候选'
  if (request !== undefined) {
    if (
      request.projectId !== evidence.projectId ||
      request.sceneId !== evidence.sceneId ||
      request.threadId !== evidence.threadId ||
      request.operationId !== evidence.operationId ||
      request.branchId !== evidence.sourceBranchId ||
      request.checkpointId !== evidence.checkpointId
    )
      return '分叉请求与来源证据不一致'
    if (
      !request.inputChanges &&
      digestJson(execution.inputSnapshot) !== evidence.inputSnapshotDigest
    )
      return '分叉输入与捕获时的来源输入不一致'
  }
  return undefined
}

function legacyCheckpointIssue(
  evidence: ForkSourceEvidence,
  checkpoint: SceneGenerationCheckpoint
): string | undefined {
  if (
    checkpoint.view.checkpointId !== evidence.checkpointId ||
    checkpoint.execution.operationId !== evidence.sourceOperationId ||
    checkpoint.execution.projectId !== evidence.projectId ||
    checkpoint.execution.sceneId !== evidence.sceneId ||
    checkpoint.execution.threadId !== evidence.threadId ||
    checkpoint.execution.branchId !== evidence.sourceBranchId ||
    checkpoint.candidateSnapshotId !== evidence.candidateSnapshotId
  )
    return '旧格式来源检查点身份与证据不一致'
  if (
    checkpoint.execution.candidateSnapshotId !== undefined &&
    checkpoint.execution.candidateSnapshotId !== evidence.candidateSnapshotId
  )
    return '旧格式来源检查点候选与证据不一致'
  if (digestJson(checkpoint.execution.inputSnapshot) !== evidence.inputSnapshotDigest)
    return '旧格式来源检查点输入与证据不一致'
  return undefined
}

function sameRevision(
  left: ForkSourceRevisionEvidence,
  right: ForkSourceRevisionEvidence
): boolean {
  return (
    left.revisionId === right.revisionId &&
    left.treeId === right.treeId &&
    left.parentRevisionIds.length === right.parentRevisionIds.length &&
    left.parentRevisionIds.every((parent, index) => parent === right.parentRevisionIds[index])
  )
}

function evidenceDigest(evidence: Omit<ForkSourceEvidence, 'digest'>): string {
  return digestJson({
    version: evidence.version,
    operationId: evidence.operationId,
    projectId: evidence.projectId,
    sceneId: evidence.sceneId,
    threadId: evidence.threadId,
    sourceOperationId: evidence.sourceOperationId,
    sourceBranchId: evidence.sourceBranchId,
    checkpointId: evidence.checkpointId,
    candidateSnapshotId: evidence.candidateSnapshotId,
    checkpointKind: evidence.checkpointKind,
    checkpointDigest: evidence.checkpointDigest,
    inputSnapshotDigest: evidence.inputSnapshotDigest,
    revision: {
      revisionId: evidence.revision.revisionId,
      treeId: evidence.revision.treeId,
      parentRevisionIds: [...evidence.revision.parentRevisionIds]
    }
  })
}

/** 严格解析证据文档；结构不符或摘要不匹配都视为不可用证据。 */
const forkSourceEvidenceSchema = z.strictObject({
  version: z.literal(1),
  operationId: z.string().min(1),
  projectId: z.string().min(1),
  sceneId: z.string().min(1),
  threadId: z.string().min(1),
  sourceOperationId: z.string().min(1),
  sourceBranchId: z.string().min(1),
  checkpointId: z.string().min(1),
  candidateSnapshotId: z.string().min(1),
  checkpointKind: z.enum(['pi-review', 'legacy']),
  checkpointDigest: z.string().regex(/^[0-9a-f]{64}$/u),
  inputSnapshotDigest: z.string().regex(/^[0-9a-f]{64}$/u),
  revision: z.strictObject({
    revisionId: z.string().regex(/^[0-9a-f]{40}$/u),
    treeId: z.string().regex(/^[0-9a-f]{40}$/u),
    parentRevisionIds: z.array(z.string().regex(/^[0-9a-f]{40}$/u))
  }),
  digest: z.string().regex(/^[0-9a-f]{64}$/u)
})

function parseForkSourceEvidence(value: unknown): ForkSourceEvidence | undefined {
  const parsed = forkSourceEvidenceSchema.safeParse(value)
  if (!parsed.success) return undefined
  const evidence: ForkSourceEvidence = parsed.data
  return evidenceDigest(evidence) === evidence.digest ? evidence : undefined
}

const forkSourceMarkerSchema = z.strictObject({
  version: z.literal(1),
  evidenceDigest: z.string().regex(/^[0-9a-f]{64}$/u)
})

/** @returns 证据摘要；标记结构不符时返回 undefined。 */
function parseForkSourceMarker(value: unknown): string | undefined {
  const parsed = forkSourceMarkerSchema.safeParse(value)
  return parsed.success ? parsed.data.evidenceDigest : undefined
}

function digestJson(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex')
}

/** 稳定序列化：对象键排序、跳过 undefined、数组中的 undefined 写作 null。 */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value))
    return `[${value.map((item) => (item === undefined ? 'null' : canonicalJson(item))).join(',')}]`
  const record = value as Record<string, unknown>
  return `{${Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(',')}}`
}
