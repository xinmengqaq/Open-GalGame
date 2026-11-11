import type { EditSceneGenerationCandidateDTO } from '../dto/SceneGenerationDTO'
import type { SceneGenerationStatusVO } from '../vo/SceneGenerationVO'

export interface SceneGenerationCandidateEditService {
  /**
   * 修改候选真实文件并使旧校验、转换结果和快照引用失效。
   * @throws {AppException} 候选过期、操作不在人工编辑状态或写入失败。
   */
  editSceneGenerationCandidate(
    request: EditSceneGenerationCandidateDTO
  ): Promise<SceneGenerationStatusVO>
}
