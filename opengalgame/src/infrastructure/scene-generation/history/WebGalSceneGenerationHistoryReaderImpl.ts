import type { SceneGenerationHistoryReader } from '@application/scene-generation/ports/SceneGenerationHistoryReader'
import type {
  ListSceneGenerationHistoryDTO,
  ReadSceneGenerationCheckpointDTO
} from '@application/scene-generation/dto/SceneGenerationDTO'
import type {
  SceneGenerationCheckpoint,
  SceneGenerationExecution
} from '@application/scene-generation/models/SceneGenerationExecution'
import type {
  SceneGenerationCheckpointVO,
  SceneGenerationHistoryVO
} from '@application/scene-generation/vo/SceneGenerationVO'
import { phaseOf } from '@application/scene-generation/mapping/SceneGenerationStateProjection'
import {
  toCheckpointVO,
  toOperationVO
} from '@application/scene-generation/mapping/SceneGenerationViewMapper'
import { AppException } from '@common/errors/AppException'
import { ErrorCodes } from '@common/errors/ErrorCodes'
import type { AiProjectFileSystemImpl } from '@infrastructure/ai/filesystem/AiProjectFileSystemImpl'
import { readCommitParent, type GitLocation } from '@infrastructure/git/objects/gitTree'
import { readWorkflowHistory } from '@infrastructure/workflow/history/workflowHistory'
import { langGraphThreadKey } from '@infrastructure/workflow/WorkflowIdentity'
import type { ReadOnlyGenerationCheckpointStore } from '@infrastructure/workflow/checkpoints/ReadOnlyCheckpointStore'
import { readDurableEffects } from '@infrastructure/workflow/execution/durableEffect'
import type { FileSceneGenerationExecutionRepositoryImpl } from '../execution/FileSceneGenerationExecutionRepositoryImpl'
import {
  PI_REVIEW_CHECKPOINT_REASON,
  isPiReviewCheckpointId,
  piReviewCheckpointId
} from '../workflow/piReviewCheckpoint'
import { candidateInputDigest } from '../workflow/graph/candidateRevision'
import { readPauseBoundary, type PiPauseBoundary } from '../pi/PiPauseBoundary'
import {
  legacyGenerationCheckpointValues,
  readWebGalGenerationCheckpoint
} from './WebGalGenerationCheckpoint'
import {
  isPublishedRevision,
  revisionBelongsToOperation,
  revisionFileDifferences
} from './RevisionFileDifferences'
import { proveForkSourceRevision } from './ForkSourceRevisionProof'

/** 分支历史里可安全展示的一项；读取视图在翻页后才执行，避免整页读盘。 */
interface HistoryEntry {
  readonly checkpointId: string
  readonly createdAt?: string
  /** 同一时间戳下保持旧历史原序；Pi 项排在旧项之后。 */
  readonly order: number
  readonly read: () => Promise<SceneGenerationCheckpointVO>
}

interface ForkProof {
  readonly canFork: boolean
  readonly reason?: string
}

export class WebGalSceneGenerationHistoryReaderImpl implements SceneGenerationHistoryReader {
  constructor(
    private readonly stateRoot: string,
    private readonly store: ReadOnlyGenerationCheckpointStore,
    private readonly files: AiProjectFileSystemImpl,
    private readonly executions: FileSceneGenerationExecutionRepositoryImpl
  ) {}

  async listHistory(request: ListSceneGenerationHistoryDTO): Promise<SceneGenerationHistoryVO> {
    if (!Number.isSafeInteger(request.limit) || request.limit < 1 || request.limit > 100)
      throw new AppException({ code: ErrorCodes.invalidRequest, msg: '历史页大小必须为 1 到 100' })
    const operations = await this.executions.listThread(request)
    if (!operations.some((item) => item.branchId === request.branchId))
      throw new AppException({ code: ErrorCodes.forbidden, msg: '分支不属于当前线程' })
    const identity = { ...request, operationId: 'history' }
    const rawHistory = await readWorkflowHistory(this.store, identity)
    const entries: HistoryEntry[] = []
    for (const [order, entry] of rawHistory.entries()) {
      const tuple = await this.store.getTuple({
        configurable: {
          thread_id: langGraphThreadKey(identity),
          checkpoint_ns: '',
          checkpoint_id: entry.checkpointId
        }
      })
      if (!tuple) continue
      const execution = executionScopeOf(legacyGenerationCheckpointValues(tuple).execution)
      if (
        execution?.projectId === request.projectId &&
        execution.sceneId === request.sceneId &&
        execution.threadId === request.threadId &&
        execution.branchId === request.branchId
      ) {
        entries.push({
          checkpointId: entry.checkpointId,
          ...(entry.createdAt === undefined ? {} : { createdAt: entry.createdAt }),
          order,
          read: async () =>
            toCheckpointVO(
              (
                await this.readCheckpoint({
                  ...request,
                  checkpointId: entry.checkpointId
                })
              ).view
            )
        })
      }
    }
    let piOrder = rawHistory.length
    for (const execution of operations) {
      if (execution.branchId !== request.branchId) continue
      const checkpointId = execution.checkpointId
      if (
        checkpointId === undefined ||
        !isPiReviewCheckpointId(checkpointId) ||
        checkpointId !== piReviewCheckpointId(execution.operationId, execution.candidateSnapshotId)
      )
        continue
      let view: SceneGenerationCheckpointVO
      try {
        view = (await this.readCheckpoint({ ...request, checkpointId })).view
      } catch {
        // 身份或记录无法证明的 Pi 边界不进入历史，不补造检查点。
        continue
      }
      const createdAt =
        execution.updatedAt ?? execution.createdAt ?? execution.timeline?.at(-1)?.createdAt
      entries.push({
        checkpointId,
        ...(createdAt === undefined ? {} : { createdAt }),
        order: piOrder++,
        read: async () => toCheckpointVO(view)
      })
    }
    entries.sort(byNewestThenOriginalOrder)
    const start = request.cursor
      ? entries.findIndex((item) => item.checkpointId === request.cursor) + 1
      : 0
    if (request.cursor && start === 0)
      throw new AppException({ code: ErrorCodes.invalidRequest, msg: '历史游标不存在' })
    const page = entries.slice(start, start + request.limit)
    const checkpoints = await Promise.all(page.map((item) => item.read()))
    return {
      branches: [...new Set(operations.map((item) => item.branchId))].map((branchId) => ({
        branchId,
        sourceBranchId: operations.find((item) => item.branchId === branchId)?.fork?.branchId
      })),
      checkpoints,
      nextCursor: start + page.length < entries.length ? page.at(-1)?.checkpointId : undefined
    }
  }

  async readCheckpoint(
    request: ReadSceneGenerationCheckpointDTO
  ): Promise<SceneGenerationCheckpoint> {
    const operations = await this.executions.listThread(request)
    if (isPiReviewCheckpointId(request.checkpointId)) {
      const execution = operations.find(
        (item) => item.checkpointId === request.checkpointId && item.branchId === request.branchId
      )
      if (!execution)
        throw new AppException({ code: ErrorCodes.invalidRequest, msg: '历史检查点不存在' })
      // 边界标识必须由本操作生成；候选后缀可以是当前修订、无候选或崩溃前的旧修订。
      if (!piBoundaryBelongsTo(request.checkpointId, execution.operationId))
        throw new AppException({
          code: ErrorCodes.invalidRequest,
          msg: '历史检查点与操作身份不一致'
        })
      const boundary =
        execution.state === 'interrupted' && execution.interruptReason === 'paused'
          ? await readPauseBoundary(this.stateRoot, execution).catch(() => null)
          : null
      return this.piCheckpoint(execution, boundary)
    }
    const record = operations.find(
      (item) => item.checkpointId === request.checkpointId && item.branchId === request.branchId
    )
    return readWebGalGenerationCheckpoint(this.store, this.stateRoot, this.files, request, record)
  }

  /** Pi 检查点的视图由执行记录、暂停边界和可证明的候选修订共同决定。 */
  private async piCheckpoint(
    execution: SceneGenerationExecution,
    boundary: PiPauseBoundary | null
  ): Promise<SceneGenerationCheckpoint> {
    const paused = execution.state === 'interrupted' && execution.interruptReason === 'paused'
    const pausedBoundary = paused && pauseBoundaryMatches(execution, boundary)
    const proof = await this.forkProof(execution, paused, pausedBoundary)
    const postwriteReading = await this.postwriteReadingProof(execution)
    const differences = await this.candidateDifferences(execution)
    return piReviewCheckpoint(execution, pausedBoundary, postwriteReading, proof, differences)
  }

  /**
   * 相邻候选摘要只从已发布修订和可证明来源计算；当前草稿、无关操作和缺少上一修订时不给差异。
   * 不读模型、不写文件；证明失败返回空，不把不可证明的字节当作历史。
   */
  private async candidateDifferences(
    execution: SceneGenerationExecution
  ): Promise<SceneGenerationCheckpoint['view']['differences']> {
    const candidateSnapshotId = execution.candidateSnapshotId
    if (candidateSnapshotId === undefined) return []
    try {
      const location = { gitdir: this.files.locateWorkspace(execution).revisionGitDir }
      if (!(await isPublishedRevision(location, candidateSnapshotId))) return []
      const beforeRevisionId = await readCommitParent(location, candidateSnapshotId)
      if (beforeRevisionId === undefined) return []
      const proven =
        (await revisionBelongsToOperation(location, beforeRevisionId, execution.operationId)) ||
        (await this.forkSourceRevision(execution, location, beforeRevisionId))
      if (!proven) return []
      return await revisionFileDifferences(location, beforeRevisionId, candidateSnapshotId)
    } catch {
      return []
    }
  }

  /**
   * 分叉来源只能由执行记录里的来源身份证明：同一场景线程、来源操作与检查点一致，
   * 且上一修订确由来源操作保存。来源候选本身作为当前候选时没有本分支的差异。
   */
  private async forkSourceRevision(
    execution: SceneGenerationExecution,
    location: GitLocation,
    revisionId: string
  ): Promise<boolean> {
    return proveForkSourceRevision(this.files, execution, revisionId, location)
  }

  /**
   * 分叉资格独立于续跑：候选修订必须与草稿一致，副作用不能有未确认结果。
   * @returns 可证明时 canFork 为真；否则给出不复制的原因。
   */
  private async forkProof(
    execution: SceneGenerationExecution,
    paused: boolean,
    pausedBoundary: boolean
  ): Promise<ForkProof> {
    const candidateSnapshotId = execution.candidateSnapshotId
    if (candidateSnapshotId === undefined)
      return { canFork: false, reason: '没有可复制的候选修订，不能分叉' }
    if (execution.checkpointId !== piReviewCheckpointId(execution.operationId, candidateSnapshotId))
      return { canFork: false, reason: '检查点与候选修订不一致，不能分叉' }
    if (execution.state !== 'waiting' && !paused)
      return { canFork: false, reason: '只有等待审阅或安全暂停的边界可以分叉' }
    if (execution.pendingReply) return { canFork: false, reason: '仍有待执行回复，不能分叉' }
    if (paused && !pausedBoundary)
      return { canFork: false, reason: '暂停边界缺失或已变化，不能分叉' }
    try {
      if (!(await this.entryMatchesRevision(execution, candidateSnapshotId)))
        return { canFork: false, reason: '候选草稿与不可变修订不一致，不能分叉' }
      const effects = await readDurableEffects(this.stateRoot, execution)
      if (effects.some((effect) => effect.status !== 'completed'))
        return { canFork: false, reason: '副作用结果尚未确认，不能分叉' }
      if (
        effects.some(
          (effect) =>
            (effect.kind === 'fileWrite' || effect.kind === 'commit') &&
            (!effect.resultDigest || !effect.candidateRevision)
        )
      )
        return { canFork: false, reason: '副作用记录不完整，不能分叉' }
    } catch {
      return { canFork: false, reason: '来源候选或副作用不可读，不能分叉' }
    }
    return { canFork: true }
  }

  /** 入口草稿必须仍是已发布且归属于本操作的不可变修订，避免复制未保存改动。 */
  private async entryMatchesRevision(
    execution: SceneGenerationExecution,
    candidateSnapshotId: string
  ): Promise<boolean> {
    const relativePath = `${execution.source.sceneDirectory}/${execution.source.entryFile}`
    const revision = await this.files.readRevisionFile({
      projectId: execution.projectId,
      threadId: execution.threadId,
      operationId: execution.operationId,
      revisionId: candidateSnapshotId,
      relativePath
    })
    if (revision === null) return false
    const draft = await this.files.readFile(this.files.locateWorkspace(execution), relativePath)
    return Buffer.from(draft.bytes).equals(Buffer.from(revision))
  }

  /**
   * 写后读取中断的继续资格：检查点绑定当前候选修订、阶段为 reading，
   * 且不可变修订、当前草稿与副作用账本都能证明同一次写入。
   * 不重新调用模型、不写文件；失败或取消终态不提供继续。
   */
  private async postwriteReadingProof(execution: SceneGenerationExecution): Promise<boolean> {
    const candidateSnapshotId = execution.candidateSnapshotId
    if (candidateSnapshotId === undefined) return false
    if (
      execution.state === 'failed' ||
      execution.state === 'cancelled' ||
      execution.state === 'succeeded'
    )
      return false
    if (
      execution.checkpointId !==
      piReviewCheckpointId(execution.operationId, candidateSnapshotId)
    )
      return false
    if (execution.interruptReason !== 'readInterrupted' && execution.step !== 'reading')
      return false
    try {
      if (!(await this.entryMatchesRevision(execution, candidateSnapshotId))) return false
      const effects = await readDurableEffects(this.stateRoot, execution)
      if (effects.length === 0 || effects.some((effect) => effect.status !== 'completed'))
        return false
      return effects.some(
        (effect) =>
          effect.kind === 'fileWrite' &&
          effect.candidateRevision === candidateSnapshotId &&
          effect.inputDigest.length > 0
      )
    } catch {
      return false
    }
  }
}

/** Pi 边界标识只能由本操作生成；后缀为无候选或某个候选修订摘要。 */
function piBoundaryBelongsTo(checkpointId: string, operationId: string): boolean {
  const prefix = `pi-review-${operationId}-`
  if (!checkpointId.startsWith(prefix)) return false
  const suffix = checkpointId.slice(prefix.length)
  return suffix === 'none' || /^[0-9a-f]{40,64}$/u.test(suffix)
}

/** 最新记录在前；时间相同按原历史顺序，Pi 项排在旧项之后。 */
function byNewestThenOriginalOrder(left: HistoryEntry, right: HistoryEntry): number {
  const leftTime = left.createdAt ?? ''
  const rightTime = right.createdAt ?? ''
  if (leftTime !== rightTime) return leftTime < rightTime ? 1 : -1
  return left.order - right.order
}

/**
 * 候选审阅与安全暂停边界由执行记录和暂停边界只读合成，不写 LangGraph 检查点。
 * 只有暂停代次、检查点、候选与输入摘要都能对上，或写后读取边界能被账本证明时 canContinue 才为真。
 */
function piReviewCheckpoint(
  execution: SceneGenerationExecution,
  pausedBoundary: boolean,
  postwriteReading: boolean,
  fork: ForkProof,
  differences: SceneGenerationCheckpoint['view']['differences']
): SceneGenerationCheckpoint {
  const candidateSnapshotId = execution.candidateSnapshotId
  const pending = execution.pendingReply
  const paused = execution.state === 'interrupted' && execution.interruptReason === 'paused'
  // 等待态可提交新的审阅回复；已持久回复在崩溃后处于 pending/running，也允许按回复继续。
  // 暂停不是回复边界：待执行回复的显式继续走 resume，不把 canReply 混成 resume。
  const replyable =
    execution.state === 'waiting' ||
    (pending !== undefined &&
      pending.reply.kind !== 'discard' &&
      (execution.state === 'pending' || execution.state === 'running'))
  const questionGroup =
    execution.interaction?.kind === 'decision' &&
    (execution.interaction.questions?.length ?? 0) > 0 &&
    candidateSnapshotId === undefined
  const unverified =
    execution.state === 'interrupted' &&
    (execution.interruptReason === 'writeUnknown' ||
      execution.interruptReason === 'candidateConflict' ||
      execution.interruptReason === 'commitUnknown')
  const reason = paused
    ? pausedBoundary
      ? fork.canFork
        ? '已安全暂停；继续会先核对操作、输入、草稿、修订与副作用'
        : (fork.reason ?? '暂停边界不能用于分叉')
      : '暂停边界缺失或已变化，不能继续'
    : postwriteReading
      ? '候选修订已保存；继续只重读候选，不重新调用模型或写入'
      : unverified
        ? execution.interruptReason === 'commitUnknown'
          ? '提交结果待核对，不能继续'
          : execution.interruptReason === 'candidateConflict'
            ? '候选或基线冲突，需要重新核对'
            : '候选写入待核对，暂不能审阅'
        : fork.canFork
          ? PI_REVIEW_CHECKPOINT_REASON
          : (fork.reason ?? PI_REVIEW_CHECKPOINT_REASON)
  return {
    execution,
    ...(candidateSnapshotId === undefined ? {} : { candidateSnapshotId }),
    view: {
      ...toOperationVO(execution),
      checkpointId: execution.checkpointId!,
      phase: phaseOf(execution.state, execution.step),
      // 题组等待没有候选，不能投影成“候选已发布”；历史按真实等待事实展示。
      summary: paused
        ? '已安全暂停，等待明确继续'
        : postwriteReading
          ? '候选已保存，可继续重读校验'
          : unverified
            ? execution.interruptReason === 'commitUnknown'
              ? '提交结果待核对'
              : execution.interruptReason === 'candidateConflict'
                ? '候选或基线冲突，需要重新核对'
                : '候选写入待核对，暂不能审阅'
            : questionGroup
              ? '等待回答创作问题，回答后继续生成'
              : candidateSnapshotId === undefined
                ? '生成等待人工处理'
                : execution.interaction?.kind === 'correction'
                  ? '候选需要修正，等待作者说明'
                  : '候选已发布，等待审阅',
      decisions: execution.replies.map((reply) => ({
        interactionId: reply.interactionId,
        reply: reply.reply
      })),
      differences,
      canView: true,
      canContinue: pausedBoundary || postwriteReading,
      canFork: fork.canFork,
      canReply: replyable,
      reason
    }
  }
}

/** 暂停代次、检查点、候选与输入摘要全部匹配才把边界视为可用。 */
function pauseBoundaryMatches(
  execution: SceneGenerationExecution,
  boundary: PiPauseBoundary | null
): boolean {
  return (
    boundary !== null &&
    boundary.projectId === execution.projectId &&
    boundary.operationId === execution.operationId &&
    boundary.threadId === execution.threadId &&
    boundary.branchId === execution.branchId &&
    boundary.checkpointId === execution.checkpointId &&
    boundary.generation === execution.attempt &&
    (boundary.candidateSnapshotId ?? undefined) === (execution.candidateSnapshotId ?? undefined) &&
    boundary.inputDigest ===
      candidateInputDigest(boundary.mode, {
        ...execution,
        ...(boundary.candidateSnapshotId === undefined
          ? {}
          : { candidateSnapshotId: boundary.candidateSnapshotId })
      })
  )
}

/**
 * 只取历史筛选所需的身份字段；旧检查点缺字段时跳过而不是伪造归属。
 */
function executionScopeOf(
  value: unknown
): { projectId: string; sceneId: string; threadId: string; branchId: string } | undefined {
  if (!value || typeof value !== 'object') return undefined
  const record = value as Record<string, unknown>
  if (
    typeof record.projectId !== 'string' ||
    typeof record.sceneId !== 'string' ||
    typeof record.threadId !== 'string' ||
    typeof record.branchId !== 'string'
  )
    return undefined
  return {
    projectId: record.projectId,
    sceneId: record.sceneId,
    threadId: record.threadId,
    branchId: record.branchId
  }
}
