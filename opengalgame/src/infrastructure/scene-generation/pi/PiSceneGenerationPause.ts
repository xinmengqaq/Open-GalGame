import type {
  SceneGenerationCandidate,
  SceneGenerationExecution,
  SceneGenerationRuntime
} from '@application/scene-generation/models/SceneGenerationExecution'
import { SceneGenerationWriteOutcomeUnknown } from '@application/scene-generation/errors/SceneGenerationWriteOutcomeUnknown'
import { AppException } from '@common/errors/AppException'
import { ErrorCodes } from '@common/errors/ErrorCodes'
import { throwIfStopped } from '@infrastructure/ai/execution/executionErrors'
import { candidateInputDigest, candidateReplyStepTag } from '@infrastructure/scene-generation/workflow/graph/candidateRevision'
import { piReviewCheckpointId } from '@infrastructure/scene-generation/workflow/piReviewCheckpoint'
import { inspectWriteEffects } from './PiSceneGenerationEffects'
import { readSceneDraft } from './SceneCandidateToolbox'
import {
  readPauseBoundary,
  writePauseBoundary,
  type PiPauseBoundary
} from './PiPauseBoundary'
import type { PassOutcome, RunState } from './PiSceneGenerationTypes'

/**
 * 在两次模型往返之间发布安全暂停：先撤销旧执行写资格，再核对副作用链并持久化边界。
 * 有在途写入或额外写入时不停在暂停，交给统一恢复边界标记待核对。
 * @throws {AppException | SceneGenerationWriteOutcomeUnknown} 边界无法安全发布。
 */
export async function pauseAtSafeCheckpoint(input: {
  readonly stateRoot: string
  readonly runtime: SceneGenerationRuntime
  readonly state: RunState
  readonly workspaceRoot: string
  readonly entryPath: string
  readonly pass: number
  readonly mode: 'generate' | 'repair'
  readonly firstMode: 'generate' | 'repair'
  readonly baseCandidateSnapshotId?: string
  readonly pendingReplyId?: string
}): Promise<PassOutcome> {
  const { state, runtime } = input
  // 先撤销旧执行的写资格；之后任何迟到的工具回调都不能再写候选。
  state.authority.revoke()
  throwIfStopped(runtime.signal)
  const chain = await inspectWriteEffects(input.stateRoot, state.execution, {
    passes: input.pass,
    firstMode: input.firstMode,
    ...(input.baseCandidateSnapshotId === undefined
      ? {}
      : { baseCandidateSnapshotId: input.baseCandidateSnapshotId }),
    ...(input.pendingReplyId === undefined
      ? {}
      : { tag: candidateReplyStepTag(input.pendingReplyId) })
  })
  const candidateSnapshotId = state.candidateSnapshotId ?? state.execution.candidateSnapshotId
  if ((chain.candidateSnapshotId ?? undefined) !== (candidateSnapshotId ?? undefined))
    throw new SceneGenerationWriteOutcomeUnknown(
      '候选修订与暂停边界不一致，已保留记录待核对'
    )
  const draft = await readSceneDraft(input.workspaceRoot, input.entryPath)
  await writePauseBoundary(input.stateRoot, {
    projectId: state.execution.projectId,
    operationId: state.execution.operationId,
    threadId: state.execution.threadId,
    branchId: state.execution.branchId,
    checkpointId: piReviewCheckpointId(state.execution.operationId, candidateSnapshotId),
    generation: state.execution.attempt,
    pass: input.pass,
    firstMode: input.firstMode,
    mode: input.mode,
    ...(input.baseCandidateSnapshotId === undefined
      ? {}
      : { baseCandidateSnapshotId: input.baseCandidateSnapshotId }),
    ...(candidateSnapshotId === undefined ? {} : { candidateSnapshotId }),
    inputDigest: candidateInputDigest(input.mode, {
      ...state.execution,
      ...(candidateSnapshotId === undefined ? {} : { candidateSnapshotId })
    }),
    draftRevision: draft.revision,
    reviewAccepted: state.reviewAccepted,
    publishedCandidates:
      state.execution.publishedCandidates?.map((item) => item.candidateSnapshotId) ?? [],
    ...(input.pendingReplyId === undefined
      ? {}
      : { pendingReplyId: input.pendingReplyId })
  })
  return {
    kind: 'interrupted',
    checkpointId: piReviewCheckpointId(state.execution.operationId, candidateSnapshotId),
    ...(candidateSnapshotId === undefined ? {} : { candidateSnapshotId }),
    attempt: state.execution.attempt
  }
}

/**
 * 读取并核对暂停边界。暂停代次必须恰好比当前显式继续代次早一次；
 * 输入摘要、草稿、候选修订、已发布关系和副作用链任何一项不一致都停止。
 * @throws {SceneGenerationWriteOutcomeUnknown} 在途写入无法归属或存在额外写入。
 */
export async function requirePauseBoundary(
  stateRoot: string,
  readCandidate: (
    execution: SceneGenerationExecution,
    candidateSnapshotId: string
  ) => Promise<SceneGenerationCandidate>,
  execution: SceneGenerationExecution
): Promise<PiPauseBoundary> {
  if (!execution.workspace)
    throw new AppException({
      code: ErrorCodes.operationConflict,
      msg: '暂停恢复缺少候选工作区'
    })
  const boundary = await readPauseBoundary(stateRoot, execution)
  if (!boundary)
    throw new AppException({
      code: ErrorCodes.operationConflict,
      msg: '暂停恢复边界不存在或已失效'
    })
  if (
    boundary.projectId !== execution.projectId ||
    boundary.operationId !== execution.operationId ||
    boundary.threadId !== execution.threadId ||
    boundary.branchId !== execution.branchId ||
    boundary.checkpointId !== execution.checkpointId ||
    boundary.generation > execution.attempt ||
    (boundary.candidateSnapshotId ?? undefined) !==
      (execution.candidateSnapshotId ?? undefined)
  )
    throw new AppException({ code: ErrorCodes.operationConflict, msg: '恢复身份或代次已过期' })
  const published =
    execution.publishedCandidates?.map((item) => item.candidateSnapshotId) ?? []
  if (
    boundary.publishedCandidates.length > published.length ||
    boundary.publishedCandidates.some((revision, index) => published[index] !== revision)
  )
    throw new AppException({
      code: ErrorCodes.operationConflict,
      msg: '已发布候选关系与暂停边界不一致'
    })
  const expectedInput = candidateInputDigest(boundary.mode, {
    ...execution,
    ...(boundary.candidateSnapshotId === undefined
      ? {}
      : { candidateSnapshotId: boundary.candidateSnapshotId })
  })
  if (boundary.inputDigest !== expectedInput)
    throw new AppException({
      code: ErrorCodes.operationConflict,
      msg: '输入摘要已变化，不能从暂停点继续'
    })
  const draft = await readSceneDraft(
    execution.workspace.rootDirectory,
    `${execution.source.sceneDirectory}/${execution.source.entryFile}`
  )
  if (draft.revision !== boundary.draftRevision)
    throw new AppException({
      code: ErrorCodes.operationConflict,
      msg: '草稿已变化，不能从暂停点继续'
    })
  const chain = await inspectWriteEffects(stateRoot, execution, {
    passes: boundary.pass,
    firstMode: boundary.firstMode,
    ...(boundary.baseCandidateSnapshotId === undefined
      ? {}
      : { baseCandidateSnapshotId: boundary.baseCandidateSnapshotId }),
    ...(boundary.pendingReplyId === undefined
      ? {}
      : { tag: candidateReplyStepTag(boundary.pendingReplyId) })
  })
  if (
    (chain.candidateSnapshotId ?? undefined) !== (boundary.candidateSnapshotId ?? undefined)
  )
    throw new SceneGenerationWriteOutcomeUnknown(
      '候选修订与暂停边界不一致，已保留记录待核对'
    )
  if (boundary.candidateSnapshotId !== undefined)
    await readCandidate(execution, boundary.candidateSnapshotId)
  return boundary
}
