import type { ForkSceneGenerationDTO } from '../../dto/SceneGenerationDTO'
import type { SceneGenerationExecution } from '../../models/SceneGenerationExecution'
import type { SceneGenerationForkResultVO } from '../../vo/SceneGenerationVO'
import { AppException } from '@common/errors/AppException'
import { ErrorCodes } from '@common/errors/ErrorCodes'
import { generationFingerprint, requireAcceptable } from './SceneGenerationApplicationRules'
import { threadKey } from '../../policies/SceneGenerationIdempotency'
import { toOperationVO } from '../../mapping/SceneGenerationViewMapper'
import type { SceneGenerationServiceContext } from './SceneGenerationServiceContext'

export class ForkSceneGenerationUseCase {
  constructor(private readonly context: SceneGenerationServiceContext) {}

  forkSceneGeneration(request: ForkSceneGenerationDTO): Promise<SceneGenerationForkResultVO> {
    const snapshot = structuredClone(request)
    return this.context.coordinator.serialize(threadKey(snapshot), async () => {
      const fingerprint = generationFingerprint(snapshot)
      const previous = await this.context.coordinator.replay(snapshot, fingerprint)
      if (previous) {
        const replaySource = previous.fork
          ? await this.context.deps.history.readCheckpoint(previous.fork).catch(() => null)
          : null
        return {
          ...toOperationVO(previous),
          forkFrom: forkOriginOf(replaySource?.view.summary ?? '历史记录', replaySource?.execution)
        }
      }
      if (!this.context.deps.workflow.capabilities().fork)
        throw new AppException({
          code: ErrorCodes.operationConflict,
          msg: '当前构建尚未启用历史分叉，原分支保持不变'
        })
      const checkpoint = await this.context.deps.history.readCheckpoint(snapshot)
      if (checkpoint.view.canFork !== true)
        throw new AppException({
          code: ErrorCodes.operationConflict,
          msg: checkpoint.view.reason ?? '该历史检查点不能分叉'
        })
      // 来源可以停在等待/暂停位置；资格来自当前执行记录，历史快照里的
      // execution.state 只说明当时，不说明线程现在是否仍有活动。
      const sourceRecord = await this.context.deps.executions.readExecution({
        projectId: snapshot.projectId,
        sceneId: snapshot.sceneId,
        operationId: checkpoint.execution.operationId
      })
      await this.context.coordinator.requireForkableThread(
        {
          projectId: snapshot.projectId,
          sceneId: snapshot.sceneId,
          operationId: checkpoint.execution.operationId,
          threadId: snapshot.threadId,
          branchId: snapshot.branchId,
          checkpointId: snapshot.checkpointId,
          ...(checkpoint.candidateSnapshotId === undefined
            ? {}
            : { candidateSnapshotId: checkpoint.candidateSnapshotId })
        },
        sourceRecord
      )
      const source = await this.context.deps.input.locateScene(snapshot)
      const inputSnapshot = snapshot.inputChanges
        ? await this.context.deps.input.readInputs(source, snapshot.inputChanges)
        : checkpoint.execution.inputSnapshot
      const baseline = await this.context.deps.versions.readBaseline(source)
      const branchId = this.context.deps.nextId()
      // 分叉决定只保存为新分支的已确认回复，来源分支的原回复保持不变。
      const replies = (snapshot.decisionChanges ?? []).map((change, index) => ({
        projectId: snapshot.projectId,
        sceneId: snapshot.sceneId,
        operationId: snapshot.operationId,
        threadId: snapshot.threadId,
        branchId,
        interactionId: change.interactionId,
        checkpointId: snapshot.checkpointId,
        ...(checkpoint.candidateSnapshotId === undefined
          ? {}
          : { candidateSnapshotId: checkpoint.candidateSnapshotId }),
        replyId: `fork-decision-${index}`,
        reply: change.reply
      }))
      const execution: SceneGenerationExecution = {
        projectId: snapshot.projectId,
        sceneId: snapshot.sceneId,
        operationId: snapshot.operationId,
        threadId: snapshot.threadId,
        branchId,
        fingerprint,
        source,
        inputSnapshot: structuredClone(inputSnapshot),
        policy: snapshot.policy,
        reviewCandidate: snapshot.reviewCandidate ?? false,
        baseline,
        state: 'pending',
        step: 'preparing',
        attempt: 0,
        sequence: 0,
        budget: { correctionsUsed: 0, modelCallsUsed: 0, toolCallsUsed: 0, activeElapsedMs: 0 },
        replies,
        fork: {
          projectId: snapshot.projectId,
          sceneId: snapshot.sceneId,
          threadId: snapshot.threadId,
          branchId: snapshot.branchId,
          checkpointId: snapshot.checkpointId,
          sourceOperationId: checkpoint.execution.operationId,
          ...(checkpoint.candidateSnapshotId === undefined
            ? {}
            : { candidateSnapshotId: checkpoint.candidateSnapshotId })
        },
        forkRequest: snapshot,
        // 来源检查点只属于 `fork` 身份，不能充当新操作的当前边界：工作流发布
        // 首个审阅/暂停边界前，新操作还没有自己的检查点。
        candidateSnapshotId: checkpoint.candidateSnapshotId
      }
      requireAcceptable(
        execution,
        { baselineState: 'unchanged', lockState: baseline.lockState },
        undefined,
        this.context.deps.domain
      )
      // 来源可能在本分叉重开前继续推进；创建时从权威检查点和不可变修订一次性捕获证据，
      // 之后只按该证据与 Git 归属核对，不再要求来源停在 C1/R1。
      const evidence = this.context.deps.forkSourceEvidence
      if (!evidence)
        throw new AppException({
          code: ErrorCodes.internalError,
          msg: '分叉来源证据未装配，不能创建分叉'
        })
      await evidence.capture(execution, checkpoint)
      const recorded = await this.context.deps.executions.createExecution(execution)
      this.context.coordinator.startExecution(
        recorded,
        (runtime) => this.context.deps.workflow.forkGeneration(runtime, snapshot),
        true
      )
      return {
        ...toOperationVO(recorded),
        forkFrom: forkOriginOf(checkpoint.view.summary, checkpoint.execution)
      }
    })
  }
}

/** 来源展示只取安全检查点摘要和已持久时间；缺失不补造。 */
function forkOriginOf(
  summary: string,
  execution: SceneGenerationExecution | undefined
): SceneGenerationForkResultVO['forkFrom'] {
  const createdAt =
    execution?.updatedAt ?? execution?.timeline?.at(-1)?.createdAt ?? execution?.createdAt
  return {
    summary,
    ...(createdAt === undefined ? {} : { createdAt })
  }
}
