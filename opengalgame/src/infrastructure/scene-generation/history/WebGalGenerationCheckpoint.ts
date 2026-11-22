import { createHash } from 'node:crypto'
import type { CheckpointTuple } from '@langchain/langgraph-checkpoint'

import type { ReadSceneGenerationCheckpointDTO } from '@application/scene-generation/dto/SceneGenerationDTO'
import type {
  SceneGenerationCheckpoint,
  SceneGenerationExecution
} from '@application/scene-generation/models/SceneGenerationExecution'
import { toOperationVO } from '@application/scene-generation/mapping/SceneGenerationViewMapper'
import { phaseOf } from '@application/scene-generation/mapping/SceneGenerationStateProjection'
import { forkSourceRecordReason } from '@application/scene-generation/policies/SceneGenerationForkBoundary'
import { AppException } from '@common/errors/AppException'
import { ErrorCodes } from '@common/errors/ErrorCodes'
import { AiProjectFileSystemImpl } from '@infrastructure/ai/filesystem/AiProjectFileSystemImpl'
import {
  readCommitFiles,
  readCommitParent,
  resolveRefIfExists
} from '@infrastructure/git/objects/gitTree'
import type { DurableEffectRecord } from '@infrastructure/workflow/DurableEffectRecord'
import { installedPackageVersion } from '@infrastructure/webgal/compatibility/WebgalCompatibilityProfile'
import { langGraphThreadKey } from '@infrastructure/workflow/WorkflowIdentity'
import { assessContinuation } from '@infrastructure/workflow/history/workflowHistory'
import { readDurableEffects } from '@infrastructure/workflow/execution/durableEffect'
import type { ReadOnlyGenerationCheckpointStore } from '@infrastructure/workflow/checkpoints/ReadOnlyCheckpointStore'
import { executionFromDocument } from '../execution/SceneGenerationExecutionDocument'
import {
  assessLegacyReviewReply,
  legacyCandidateWriteProven
} from './LegacyReviewReplyProof'
import { revisionFileDifferences } from './RevisionFileDifferences'

const NULL_TASK_ID = '00000000-0000-0000-0000-000000000000'

/** 旧图状态中历史读取实际依赖的字段；不是产品持久格式，也不重建旧图。 */
export interface LegacyGenerationCheckpointValues {
  execution?: unknown
  compatibility?: unknown
  summary?: unknown
  unresolvedIssues?: unknown
  status?: unknown
  outcome?: unknown
  candidate?: { candidateSnapshotId?: unknown; preview?: SceneGenerationCheckpoint['view']['preview'] }
  'branch:to:waitForHuman'?: unknown
}

/**
 * 读取检查点里保存的图状态值。已完成的输入写入按 LangGraph 的只读语义合并；
 * 不使用旧图运行时，也不执行节点。
 */
export function legacyGenerationCheckpointValues(
  tuple: CheckpointTuple
): LegacyGenerationCheckpointValues {
  const values: Record<string, unknown> = { ...tuple.checkpoint.channel_values }
  for (const [taskId, channel, value] of tuple.pendingWrites ?? []) {
    if (taskId === NULL_TASK_ID) values[channel] = value
  }
  return values as LegacyGenerationCheckpointValues
}

export function webGalGenerationCompatibility(): { version: 1; engine: string; parser: string } {
  return {
    version: 1,
    engine: installedPackageVersion('webgal-engine'),
    parser: installedPackageVersion('webgal-parser')
  }
}

export function generationInputDigest(execution: SceneGenerationExecution): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        inputs: execution.inputSnapshot,
        baseline: execution.baseline,
        policy: execution.policy,
        source: execution.source
      })
    )
    .digest('hex')
}

export async function readWebGalGenerationCheckpoint(
  store: ReadOnlyGenerationCheckpointStore,
  stateRoot: string,
  files: AiProjectFileSystemImpl,
  request: ReadSceneGenerationCheckpointDTO,
  record?: SceneGenerationExecution
): Promise<SceneGenerationCheckpoint> {
  const identity = { ...request, operationId: 'history' }
  const config = {
    configurable: {
      thread_id: langGraphThreadKey(identity),
      checkpoint_ns: '',
      checkpoint_id: request.checkpointId
    }
  }
  const tuple = await store.getTuple(config)
  if (!tuple) throw new AppException({ code: ErrorCodes.invalidRequest, msg: '历史检查点不存在' })
  const state = legacyGenerationCheckpointValues(tuple)
  const execution = executionFromDocument(state.execution)
  if (
    execution.projectId !== request.projectId ||
    execution.sceneId !== request.sceneId ||
    execution.threadId !== request.threadId ||
    execution.branchId !== request.branchId
  )
    throw new AppException({ code: ErrorCodes.forbidden, msg: '检查点不属于当前场景分支' })
  const checkpointInputDigest = generationInputDigest(execution)
  const association = await store.readAssociation(execution, request.checkpointId)
  let reason: string | undefined
  let candidateRevisionProven = false
  let entryPresent = false
  let workspaceMatches = false
  if (JSON.stringify(state.compatibility) !== JSON.stringify(webGalGenerationCompatibility()))
    reason = '检查点引擎或业务格式不兼容'
  else if (
    !association ||
    association.operationId !== execution.operationId ||
    association.inputDigest !== checkpointInputDigest ||
    association.candidateRevision !== execution.candidateSnapshotId
  )
    reason = '检查点缺少完整输入或候选修订关联'
  else if (execution.candidateSnapshotId) {
    const workspace = files.locateWorkspace(execution)
    try {
      const ref = await resolveRefIfExists(
        { gitdir: workspace.revisionGitDir },
        `refs/opengalgame/revisions/${execution.candidateSnapshotId}`
      )
      if (ref !== execution.candidateSnapshotId) reason = '候选修订缺失'
      else {
        const revisionFiles = await readCommitFiles(
          { gitdir: workspace.revisionGitDir },
          execution.candidateSnapshotId
        )
        candidateRevisionProven = true
        entryPresent = revisionFiles.some(
          (file) => file.relativePath === entryPathOf(execution)
        )
        workspaceMatches =
          record !== undefined &&
          (await workspaceMatchesRevision(files, execution, revisionFiles))
      }
    } catch {
      reason = '候选修订缺失或损坏'
    }
  }
  let differences: SceneGenerationCheckpoint['view']['differences'] = []
  if (!reason && execution.candidateSnapshotId)
    differences = await candidateFileDifferences(files, execution)
  const effects = reason === undefined ? await readDurableEffects(stateRoot, execution) : []
  if (!reason) {
    const assessed = assessContinuation(effects)
    if (!assessed.continuable) reason = assessed.reason
  }
  const currentState = record?.state ?? execution.state
  if (!reason && ['failed', 'cancelled', 'succeeded'].includes(currentState))
    reason =
      currentState === 'cancelled'
        ? '操作已取消，候选仅供查看，不能继续'
        : '操作已结束，候选仅供查看，不能继续'
  const inputDigestProven =
    record !== undefined &&
    association !== undefined &&
    association.inputDigest === checkpointInputDigest &&
    generationInputDigest(record) === checkpointInputDigest
  const forkReason =
    reason === undefined
      ? legacyForkBoundaryReason({
          status: state.status,
          outcome: state.outcome,
          candidate: state.candidate,
          waitForHumanSource: state['branch:to:waitForHuman'],
          checkpointExecution: execution,
          checkpointId: request.checkpointId,
          record,
          inputDigestProven,
          candidateRevisionProven,
          entryPresent,
          effects
        })
      : undefined
  const replyEvidence =
    record === undefined
      ? undefined
      : assessLegacyReviewReply({
          checkpointId: request.checkpointId,
          checkpointExecution: execution,
          ...(typeof tuple.checkpoint.ts === 'string'
            ? { checkpointTimestamp: tuple.checkpoint.ts }
            : {}),
          record,
          checkpointContinuable: reason === undefined,
          inputDigestProven,
          candidateRevisionProven,
          workspaceMatchesRevision: workspaceMatches,
          entryPresent,
          effects
        })
  const canFork = reason === undefined && forkReason === undefined
  const viewReason = reason ?? forkReason
  return {
    execution,
    candidateSnapshotId: execution.candidateSnapshotId,
    summary: typeof state.summary === 'string' ? state.summary : undefined,
    unresolvedIssues: Array.isArray(state.unresolvedIssues) ? state.unresolvedIssues : undefined,
    view: {
      ...toOperationVO(execution),
      checkpointId: request.checkpointId,
      phase: phaseOf(currentState, record?.step ?? execution.step),
      summary: typeof state.summary === 'string' && state.summary ? state.summary : '场景生成检查点',
      decisions: execution.replies.map((reply) => ({
        interactionId: reply.interactionId,
        reply: reply.reply
      })),
      differences,
      preview: state.candidate?.preview,
      canView: true,
      canContinue: !reason,
      canFork,
      ...(replyEvidence === undefined ? {} : { canReply: replyEvidence.replyable }),
      ...(viewReason === undefined ? {} : { reason: viewReason })
    }
  }
}

interface LegacyForkBoundaryInput {
  readonly status: unknown
  readonly outcome: unknown
  readonly candidate: unknown
  readonly waitForHumanSource: unknown
  readonly checkpointExecution: SceneGenerationExecution
  readonly checkpointId: string
  readonly record?: SceneGenerationExecution
  readonly inputDigestProven: boolean
  readonly candidateRevisionProven: boolean
  readonly entryPresent: boolean
  readonly effects: readonly DurableEffectRecord[]
}

const LEGACY_WAIT_FOR_HUMAN_SOURCE: Record<string, true> = {
  validateCandidate: true,
  writeCandidate: true,
  finalize: true,
  repair: true
}

/**
 * 旧检查点只有同时证明人工等待边界、已发布候选修订、当前记录和已结算写入才可分叉。
 * execution.state 是运行时的旧快照，不参与当前活动判断。
 * @returns 不可分叉的安全原因；可复制时为 undefined。
 */
function legacyForkBoundaryReason(input: LegacyForkBoundaryInput): string | undefined {
  const candidateSnapshotId = input.checkpointExecution.candidateSnapshotId
  if (candidateSnapshotId === undefined) return '没有可复制的候选修订，不能分叉'
  if (input.status !== 'waiting' && input.status !== 'paused')
    return '只有旧版等待审阅或安全暂停的检查点可以分叉'
  if (
    input.status === 'waiting' &&
    !(
      typeof input.waitForHumanSource === 'string' &&
      LEGACY_WAIT_FOR_HUMAN_SOURCE[input.waitForHumanSource] === true
    )
  )
    return '检查点不在旧版人工等待边界，不能分叉'
  const channelCandidateId = checkpointCandidateId(input.candidate)
  const outcomeCandidateId = checkpointOutcomeCandidateId(input.outcome)
  if (channelCandidateId === null || outcomeCandidateId === null)
    return '检查点保存的候选事实不完整，不能分叉'
  if (channelCandidateId === undefined && outcomeCandidateId === undefined)
    return '检查点没有保存可核对的候选边界，不能分叉'
  if (
    (channelCandidateId !== undefined && channelCandidateId !== candidateSnapshotId) ||
    (outcomeCandidateId !== undefined && outcomeCandidateId !== candidateSnapshotId)
  )
    return '检查点保存的候选与执行快照不一致，不能分叉'
  const recordReason = forkSourceRecordReason(input.record, {
    projectId: input.checkpointExecution.projectId,
    sceneId: input.checkpointExecution.sceneId,
    operationId: input.checkpointExecution.operationId,
    threadId: input.checkpointExecution.threadId,
    branchId: input.checkpointExecution.branchId,
    checkpointId: input.checkpointId,
    candidateSnapshotId
  })
  if (recordReason !== undefined) return recordReason
  if (!input.candidateRevisionProven) return '候选修订缺失或损坏，不能分叉'
  if (!input.entryPresent) return '候选修订缺少入口脚本，不能分叉'
  if (!input.inputDigestProven) return '输入摘要与检查点不一致，不能分叉'
  if (!legacyCandidateWriteProven(input.effects, candidateSnapshotId))
    return '写账本未证明当前候选已完整写入，不能分叉'
  return undefined
}

/** 旧候选通道缺失返回 undefined；存在但缺少修订标识返回 null。 */
function checkpointCandidateId(value: unknown): string | null | undefined {
  if (value === undefined) return undefined
  if (!value || typeof value !== 'object') return null
  if (!('candidateSnapshotId' in value)) return null
  const candidateSnapshotId = value.candidateSnapshotId
  return typeof candidateSnapshotId === 'string' && candidateSnapshotId.length > 0
    ? candidateSnapshotId
    : null
}

/** 旧路由结果缺失返回 undefined；存在但不是候选边界返回 null。 */
function checkpointOutcomeCandidateId(value: unknown): string | null | undefined {
  if (value === undefined) return undefined
  if (!value || typeof value !== 'object') return null
  if (!('kind' in value) || value.kind !== 'candidate') return null
  if (!('candidateSnapshotId' in value)) return null
  const candidateSnapshotId = value.candidateSnapshotId
  return typeof candidateSnapshotId === 'string' && candidateSnapshotId.length > 0
    ? candidateSnapshotId
    : null
}

function entryPathOf(execution: SceneGenerationExecution): string {
  return `${execution.source.sceneDirectory}/${execution.source.entryFile}`
}

interface RevisionFile {
  readonly relativePath: string
  readonly bytes: Uint8Array
}

/** 接受和修改都以不可变修订重建工作区；工作区当前字节也必须能对上该修订。 */
async function workspaceMatchesRevision(
  files: AiProjectFileSystemImpl,
  execution: SceneGenerationExecution,
  revisionFiles: readonly RevisionFile[]
): Promise<boolean> {
  try {
    const workspace = files.locateWorkspace(execution)
    const paths = await files.listFiles(workspace)
    if (paths.length !== revisionFiles.length) return false
    const expected = new Map(revisionFiles.map((file) => [file.relativePath, file.bytes]))
    for (const relativePath of paths) {
      const bytes = expected.get(relativePath)
      if (bytes === undefined) return false
      const actual = await files.readFile(workspace, relativePath)
      if (!Buffer.from(actual.bytes).equals(Buffer.from(bytes))) return false
    }
    return true
  } catch {
    return false
  }
}

async function candidateFileDifferences(
  files: AiProjectFileSystemImpl,
  execution: SceneGenerationExecution
): Promise<SceneGenerationCheckpoint['view']['differences']> {
  const location = { gitdir: files.locateWorkspace(execution).revisionGitDir }
  const currentId = execution.candidateSnapshotId!
  const parentId = await readCommitParent(location, currentId)
  return revisionFileDifferences(location, parentId, currentId)
}
