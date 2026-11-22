import type {
  ListSceneGenerationHistoryForSceneDTO,
  SceneGenerationScopeDTO,
  SceneGenerationThreadDTO
} from '../dto/SceneGenerationDTO'
import type { SceneGenerationExecution } from '../models/SceneGenerationExecution'

export interface SceneGenerationExecutionRepository {
  readExecution(scope: SceneGenerationScopeDTO): Promise<SceneGenerationExecution | null>

  findActiveExecution(scope: SceneGenerationThreadDTO): Promise<SceneGenerationExecution | null>

  createExecution(execution: SceneGenerationExecution): Promise<SceneGenerationExecution>

  writeExecution(execution: SceneGenerationExecution): Promise<SceneGenerationExecution>

  listSceneExecutions(
    request: ListSceneGenerationHistoryForSceneDTO
  ): Promise<readonly SceneGenerationExecution[]>

  /**
   * 只读列出本工程全部操作，供工程打开时的已受理取消清理使用。
   * 不扫描其它工程，也不隐式修复或写回执行状态。
   * @throws {AppException} 工程身份不合法或读取失败。
   */
  listProjectExecutions(projectId: string): Promise<readonly SceneGenerationExecution[]>

  findLatestSceneExecution(
    projectId: string,
    sceneId: string
  ): Promise<SceneGenerationExecution | null>
}
