import type { ReplySceneGenerationInteractionDTO } from '@application/scene-generation/dto/SceneGenerationDTO'
import type {
  SceneGenerationCandidate,
  SceneGenerationExecution
} from '@application/scene-generation/models/SceneGenerationExecution'
import { webGalGenerationCompatibility } from '../history/WebGalGenerationCheckpoint'
import type { WebGalGenerationStateValue } from './WebGalGenerationState'

/** 工作流入口只区分路由，持久身份和输入仍由执行快照决定。 */
export type WebGalWorkflowEntry = 'generate' | 'resume' | 'reply' | 'fork' | 'forkRepair'

/**
 * 安全检查点暂停意图按操作标识绑定。
 * 没有持久 pauseRequested 的调用不能中断当前运行。
 */
export class WebGalWorkflowPauseRequests {
  private readonly requested: Record<string, true> = {}

  request(execution: SceneGenerationExecution): void {
    if (execution.pauseRequested === true) this.requested[execution.operationId] = true
  }

  isRequested(operationId: string, execution: SceneGenerationExecution): boolean {
    return this.requested[operationId] === true || execution.pauseRequested === true
  }

  clear(operationId: string): void {
    delete this.requested[operationId]
  }
}

/**
 * 非 resume 入口只延续已确认上下文；本次运行事实从零开始，不继承旧检查点。
 * @param candidate - 当前操作保留的候选修订；只有它决定权威写入集合。
 */
export function createInitialRunState(
  execution: SceneGenerationExecution,
  entry: WebGalWorkflowEntry,
  previousState: Partial<WebGalGenerationStateValue>,
  candidate: SceneGenerationCandidate | undefined
): Partial<WebGalGenerationStateValue> {
  const repairSource = execution.repairSource !== undefined
  const decisionChanged = (execution.forkRequest?.decisionChanges?.length ?? 0) > 0
  return {
    execution,
    mode:
      execution.mode === 'repair' ||
      entry === 'forkRepair' ||
      execution.pendingReply?.reply.kind === 'revise'
        ? ('repair' as const)
        : execution.mode === 'validate'
          ? ('validate' as const)
          : candidate
            ? ('validate' as const)
            : ('generate' as const),
    candidate,
    summary: repairSource || decisionChanged ? '' : (previousState.summary ?? ''),
    unresolvedIssues: repairSource ? [] : (previousState.unresolvedIssues ?? []),
    memoryMessages: repairSource || decisionChanged ? [] : (previousState.memoryMessages ?? []),
    confirmedReplies: confirmedRepliesForRun(
      repairSource ? [] : (previousState.confirmedReplies ?? []),
      execution
    ),
    // D2：候选存在时旧题组失效，不再作为本次决定边界。
    questions: execution.candidateSnapshotId ? [] : (previousState.questions ?? []),
    status: 'working' as const,
    needsDecision: false,
    outcome: undefined,
    retryCount: 0,
    finalizeCount: 0,
    repairRequested: false,
    blockedReason: undefined,
    failureClass: undefined,
    failureReason: undefined,
    failureMessage: undefined,
    writtenFiles: initialWrittenFiles(execution, candidate),
    correctableIssueKey: undefined,
    summaryDegraded: undefined,
    compatibility: webGalGenerationCompatibility()
  }
}

/**
 * 候选修订的可写文件只有场景入口；既有候选存在时以该入口作为权威集合。
 * 不从旧运行继承写入路径，也不把候选快照中的其他文件当成本次写入。
 */
function initialWrittenFiles(
  execution: SceneGenerationExecution,
  candidate: SceneGenerationCandidate | undefined
): readonly string[] {
  if (!candidate?.artifact.hasEntry) return []
  return [`${execution.source.sceneDirectory}/${execution.source.entryFile}`]
}

function confirmedRepliesForRun(
  previous: readonly ReplySceneGenerationInteractionDTO[],
  execution: SceneGenerationExecution
): ReplySceneGenerationInteractionDTO[] {
  const replacements = replacementReplies(execution)
  const replaced = new Set(replacements.map((reply) => reply.interactionId))
  return [
    ...previous.filter(
      (reply) =>
        !replaced.has(reply.interactionId) &&
        !execution.replies.some(
          (current) =>
            current.replyId === reply.replyId && current.operationId === reply.operationId
        )
    ),
    ...execution.replies,
    ...replacements
  ]
}

/**
 * 同一交互只保留最后一次替换。
 * @returns 新的已确认回复；没有替换时为空。
 */
function replacementReplies(
  execution: SceneGenerationExecution
): ReplySceneGenerationInteractionDTO[] {
  const changes = execution.forkRequest?.decisionChanges ?? []
  const byInteraction = new Map<string, ReplySceneGenerationInteractionDTO>()
  changes.forEach((change, index) => {
    byInteraction.set(change.interactionId, {
      projectId: execution.projectId,
      sceneId: execution.sceneId,
      operationId: execution.operationId,
      threadId: execution.threadId,
      branchId: execution.branchId,
      interactionId: change.interactionId,
      checkpointId: execution.forkRequest!.checkpointId,
      candidateSnapshotId: execution.candidateSnapshotId,
      replyId: `fork-decision-${index}`,
      reply: change.reply
    })
  })
  return [...byInteraction.values()]
}
