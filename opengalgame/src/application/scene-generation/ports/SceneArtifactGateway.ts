import type {
  SceneGenerationCandidate,
  SceneGenerationExecution
} from '../models/SceneGenerationExecution'
import type { EditSceneGenerationCandidateDTO } from '../dto/SceneGenerationDTO'

export interface SceneArtifactGateway {
  /**
   * 写入人工修改的候选真实文件并建立新的不可变内容版本。
   * @throws {AppException} 候选版本过期、路径越界或写入失败。
   */
  writeCandidateFiles(
    execution: SceneGenerationExecution,
    request: EditSceneGenerationCandidateDTO
  ): Promise<{ candidateSnapshotId: string }>

  /**
   * @returns 同次读取的领域语义、文件定位和明确素材修改集；预览不作为内容源。
   * @throws {AppException} 读取、解析、引用或预览转换发生技术失败。
   */
  readCandidate(
    execution: SceneGenerationExecution,
    candidateSnapshotId: string
  ): Promise<SceneGenerationCandidate>
  /** 保存真实候选的不可变修订，可靠发布后返回标识。 */
  saveCandidateRevision(
    execution: SceneGenerationExecution
  ): Promise<{ candidateSnapshotId: string }>
}
