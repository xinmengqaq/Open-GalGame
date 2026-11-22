import type { ReplySceneGenerationInteractionDTO } from '../../dto/SceneGenerationDTO'
import type { SceneGenerationExecution } from '../../models/SceneGenerationExecution'
import type { SceneGenerationReplyReceiptVO } from '../../vo/SceneGenerationVO'
import { AppException } from '@common/errors/AppException'
import { ErrorCodes } from '@common/errors/ErrorCodes'
import { replyFingerprint, threadKey } from '../../policies/SceneGenerationIdempotency'
import { toReplyReceipt } from '../../mapping/SceneGenerationViewMapper'
import { isAnswerGroup } from './SceneGenerationRequestGuards'
import type { SceneGenerationServiceContext } from './SceneGenerationServiceContext'

export class ReplySceneGenerationInteractionUseCase {
  constructor(private readonly context: SceneGenerationServiceContext) {}

  async replySceneGenerationInteraction(
    request: ReplySceneGenerationInteractionDTO
  ): Promise<SceneGenerationReplyReceiptVO> {
    const snapshot = structuredClone(request)
    const execution = await this.context.coordinator.requireExecution(snapshot)
    return this.context.coordinator.serialize(threadKey(execution), async () => {
      const current = await this.context.coordinator.requireExecution(snapshot)
      const accepted = current.replies.find((reply) => reply.replyId === snapshot.replyId)
      if (accepted) {
        if (
          accepted.interactionId !== snapshot.interactionId ||
          replyFingerprint(accepted.reply) !== replyFingerprint(snapshot.reply)
        ) {
          throw new AppException({
            code: ErrorCodes.operationConflict,
            msg: '同一回复标识对应的内容不一致'
          })
        }
        return toReplyReceipt(current, accepted)
      }
      // 未实现的继续动作必须在写入 pendingReply 之前拒绝；失败不能把 waiting 变成 failed。
      if (
        snapshot.reply.kind !== 'discard' &&
        !this.context.deps.workflow.capabilities().continueInteraction
      ) {
        throw new AppException({
          code: ErrorCodes.invalidRequest,
          msg: '当前构建尚未启用此交互动作，等待保持不变'
        })
      }
      const checkpoint = current.checkpointId
        ? await this.context.deps.history.readCheckpoint({
            ...current,
            checkpointId: current.checkpointId
          })
        : undefined
      const domainService = this.context.deps.domain
      const confirmed = domainService.validateReply(
        current,
        snapshot,
        checkpoint
          ? { ...checkpoint.view, candidateSnapshotId: checkpoint.candidateSnapshotId }
          : undefined
      )
      const inspected =
        snapshot.reply.kind === 'discard'
          ?
            current
          : await this.context.coordinator.requireCurrentBaseline(current)
      const acceptedReply: ReplySceneGenerationInteractionDTO = isAnswerGroup(confirmed)
        ? { ...snapshot, selections: confirmed }
        : confirmed
          ? { ...snapshot, selection: confirmed }
          : snapshot
      const updated: SceneGenerationExecution = {
        ...inspected,
        replies: [...current.replies, acceptedReply],
        pendingReply: acceptedReply,
        state: 'pending'
      }
      const recorded = await this.context.deps.executions.writeExecution(updated)
      if (snapshot.reply.kind === 'discard') {
        this.context.coordinator.startExecution(
          recorded,
          async () => {
            throw new AppException({ code: ErrorCodes.operationConflict, msg: '已丢弃候选' })
          },
          true,
          true
        )
      } else {
        this.context.coordinator.startExecution(
          recorded,
          (runtime) => this.context.deps.workflow.continueInteraction(runtime),
          true
        )
      }
      return toReplyReceipt(recorded, snapshot)
    })
  }
}
