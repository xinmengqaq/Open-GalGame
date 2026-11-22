import type {
  SceneGenerationCandidate,
  SceneGenerationExecution
} from '../models/SceneGenerationExecution'
import type { EditSceneGenerationCandidateDTO } from '../dto/SceneGenerationDTO'

export interface SceneArtifactGateway {
  writeCandidateFiles(
    execution: SceneGenerationExecution,
    request: EditSceneGenerationCandidateDTO
  ): Promise<{ candidateSnapshotId: string }>

  readCandidate(
    execution: SceneGenerationExecution,
    candidateSnapshotId: string
  ): Promise<SceneGenerationCandidate>
  /**
   * 比较候选所有真实字节与不可变修订，禁止用旧校验提交新内容。
   * @throws {AppException} 修订缺失或当前工作区内容与修订不一致。
   */
  verifyRevision(execution: SceneGenerationExecution, candidateSnapshotId: string): Promise<void>

  saveCandidateRevision(
    execution: SceneGenerationExecution
  ): Promise<{ candidateSnapshotId: string }>
}
