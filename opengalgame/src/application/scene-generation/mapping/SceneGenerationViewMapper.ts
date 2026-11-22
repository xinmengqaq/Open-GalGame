import type { SceneGenerationExecution } from '../models/SceneGenerationExecution'
import type { ReplySceneGenerationInteractionDTO } from '../dto/SceneGenerationDTO'
import type {
  SceneGenerationCheckpointVO,
  SceneGenerationOperationVO,
  SceneGenerationReplyReceiptVO,
  SceneGenerationStatusVO
} from '../vo/SceneGenerationVO'
import { publicFailureOf } from '../models/SceneGenerationFailureFacts'
import { isTerminalState, phaseOf } from './SceneGenerationStateProjection'

export function toOperationVO(execution: SceneGenerationOperationVO): SceneGenerationOperationVO {
  return {
    projectId: execution.projectId,
    sceneId: execution.sceneId,
    operationId: execution.operationId,
    threadId: execution.threadId,
    branchId: execution.branchId
  }
}

export function toStatusVO(
  execution: SceneGenerationExecution,
  running: boolean
): SceneGenerationStatusVO {
  return structuredClone({
    ...toOperationVO(execution),
    state: execution.state,
    phase: phaseOf(execution.state, execution.step),
    attempt: execution.attempt,
    sequence: execution.sequence,
    canResume:
      !running &&
      !isTerminal(execution) &&
      execution.state !== 'waiting' &&
      execution.state !== 'cancelling' &&
      execution.cancellationRequested !== true &&
      execution.requiresCleanup !== true &&
      execution.interruptReason !== 'writeUnknown' &&
      execution.interruptReason !== 'commitUnknown' &&
      execution.interruptReason !== 'candidateConflict',
    interaction: execution.state === 'running' ? undefined : execution.interaction,
    result: execution.result,
    failure: execution.failure
      ? publicFailureOf(
          {
            ...execution.failure,
            ...(execution.candidateSnapshotId
              ? { candidateSnapshotId: execution.candidateSnapshotId }
              : {}),
            ...((execution.state === 'failed' || execution.state === 'cancelled') &&
            execution.candidateSnapshotId
              ? {
                  previewAuthorization:
                    execution.artifactValidation?.issues.length === 0 ? 'readOnly' : 'unavailable'
                }
              : {})
          },
          execution.interruptReason === 'commitUnknown' ||
            execution.interruptReason === 'writeUnknown'
        )
      : undefined,
    rollbackCommitId: execution.rollbackCommitId,
    checkpointId: execution.checkpointId,
    candidateSnapshotId: execution.candidateSnapshotId
  })
}

export function toReplyReceipt(
  execution: SceneGenerationExecution,
  reply: ReplySceneGenerationInteractionDTO
): SceneGenerationReplyReceiptVO {
  return {
    ...toOperationVO(execution),
    interactionId: reply.interactionId,
    replyId: reply.replyId,
    accepted: true
  }
}

export function toCheckpointVO(view: SceneGenerationCheckpointVO): SceneGenerationCheckpointVO {
  return structuredClone({
    ...toOperationVO(view),
    checkpointId: view.checkpointId,
    phase: view.phase,
    summary: view.summary,
    decisions: view.decisions,
    differences: view.differences,
    preview: view.preview,
    canView: view.canView,
    canContinue: view.canContinue,
    canFork: view.canFork,
    ...(view.canReply === undefined ? {} : { canReply: view.canReply }),
    reason: view.reason
  })
}

export function isTerminal(execution: SceneGenerationExecution): boolean {
  return isTerminalState(execution.state)
}
