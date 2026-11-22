import type { EditSceneGenerationCandidateDTO } from '../../dto/SceneGenerationDTO'
import type { SceneGenerationExecution } from '../../models/SceneGenerationExecution'
import type { SceneCandidatePreviewGateway } from '../../ports/SceneCandidatePreviewGateway'
import type { SceneGenerationStatusVO } from '../../vo/SceneGenerationVO'
import { AppException } from '@common/errors/AppException'
import { ErrorCodes } from '@common/errors/ErrorCodes'
import { operationKey, threadKey } from '../../policies/SceneGenerationIdempotency'
import { toStatusVO } from '../../mapping/SceneGenerationViewMapper'

import type { SceneGenerationCandidateEditService } from '../SceneGenerationCandidateEditService'
import {
  SceneGenerationCoordinator,
  type SceneGenerationDependencies
} from './SceneGenerationCoordinator'
export class EditSceneGenerationCandidate implements SceneGenerationCandidateEditService {
  constructor(
    private readonly deps: SceneGenerationDependencies,
    private readonly coordinator: SceneGenerationCoordinator,
    private readonly preview?: SceneCandidatePreviewGateway
  ) {}
  async editSceneGenerationCandidate(
    request: EditSceneGenerationCandidateDTO
  ): Promise<SceneGenerationStatusVO> {
    const snapshot = structuredClone(request)
    const execution = await this.coordinator.requireExecution(snapshot)
    return this.coordinator.serialize(threadKey(execution), async () => {
      const current = await this.coordinator.requireExecution(snapshot)
      if (this.coordinator.activeExecutions.has(operationKey(snapshot)))
        throw new AppException({
          code: ErrorCodes.operationConflict,
          msg: '场景生成仍在执行，不能修改候选'
        })
      if (!['waiting', 'interrupted'].includes(current.state) || !current.candidateSnapshotId)
        throw new AppException({
          code: ErrorCodes.operationConflict,
          msg: '当前操作没有可编辑的候选'
        })
      if (current.candidateSnapshotId !== snapshot.candidateSnapshotId)
        throw new AppException({
          code: ErrorCodes.operationConflict,
          msg: '候选内容已变化，请重新读取'
        })
      const inspected = await this.coordinator.requireCurrentBaseline(current)
      const updatedSnapshot = await this.deps.artifacts.writeCandidateFiles(inspected, snapshot)
      const updated: SceneGenerationExecution = {
        ...inspected,
        candidateSnapshotId: updatedSnapshot.candidateSnapshotId,
        checkpointId: undefined,
        preview: undefined,
        // 校验结论属于被替换的修订，人工写入后必须重新校验，不能沿用旧结论。
        artifactValidation: undefined,
        interaction: undefined,
        pendingReply: undefined,
        state: 'interrupted',
        step: 'reading',
        sequence: inspected.sequence + 1
      }
      const recorded = await this.coordinator.writeExecution(updated)
      await this.preview?.invalidateCandidatePreviewSessions({
        projectId: current.projectId,
        sceneId: current.sceneId,
        operationId: current.operationId,
        candidateSnapshotId: current.candidateSnapshotId
      })
      return toStatusVO(recorded.execution, false)
    })
  }
}
