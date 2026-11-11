import type {
  ListSceneGenerationHistoryForSceneDTO,
  SceneGenerationScopeDTO,
  SceneGenerationThreadDTO
} from '../dto/SceneGenerationDTO'
import type { SceneGenerationExecution } from '../models/SceneGenerationExecution'

export interface SceneGenerationExecutionRepository {
  /**
   * 只读查询持久操作及恢复依据，不自动恢复或写状态。
   * @returns 本场景的操作；不存在返回 null，身份越界明确拒绝。
   * @throws {AppException} 身份越界或状态读取失败。
   */
  readExecution(scope: SceneGenerationScopeDTO): Promise<SceneGenerationExecution | null>

  /**
   * 查询线程中尚未结束的操作，等待人工与待恢复操作均占据逻辑位置。
   * @returns 活动操作或 null，不隐式修复旧运行状态。
   * @throws {AppException} 线程身份越界或读取失败。
   */
  findActiveExecution(scope: SceneGenerationThreadDTO): Promise<SceneGenerationExecution | null>

  /**
   * 原子建立操作及首次线程、分支关联，核对既有分支属于同一工程和场景。
   * @param execution - 不含 SDK、凭据或 IPC 上下文的初始执行事实。
   * @returns 写入后的执行记录，时间字段由仓库决定。
   * @throws {AppException} 身份或活动操作冲突，或持久记录失败。
   */
  createExecution(execution: SceneGenerationExecution): Promise<SceneGenerationExecution>

  /**
   * 持久记录本操作事实；先可靠写候选快照再记录其引用，不替代作品提交。
   * @returns 写入后的执行记录，时间字段由仓库决定。
   * @throws {AppException} 持久记录失败。
   */
  writeExecution(execution: SceneGenerationExecution): Promise<SceneGenerationExecution>

  /**
   * 只读列出当前场景已保存的操作。旧格式记录保留但不进入当前历史。
   * @throws {AppException} 身份越界或读取失败。
   */
  listSceneExecutions(
    request: ListSceneGenerationHistoryForSceneDTO
  ): Promise<readonly SceneGenerationExecution[]>

  /**
   * 只读查询当前场景最近一次持久化的操作，不要求已有检查点，也不隐式修复。
   * 运行中的操作在产生检查点前也必须能被读到。
   * @returns 最新的执行记录；没有记录返回 null。
   * @throws {AppException} 身份越界或读取失败。
   */
  findLatestSceneExecution(
    projectId: string,
    sceneId: string
  ): Promise<SceneGenerationExecution | null>
}
