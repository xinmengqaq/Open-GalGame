import type {
  SceneGenerationExecution,
  SceneGenerationRepairSource,
  SceneGenerationWorkspace
} from '../models/SceneGenerationExecution'

export interface SceneGenerationWorkspaceGateway {
  /**
   * 建立按操作隔离、具有真实 WebGAL 布局的可变候选工作区。
   * @returns 受限候选工作区，不写正式工程。
   * @throws {AppException} 工作区建立失败。
   */
  createWorkspace(execution: SceneGenerationExecution): Promise<SceneGenerationWorkspace>

  /**
   * 核对快照完整性并恢复独立候选工作区；空快照只允许明确的准备阶段。
   * @param execution - 要恢复或分叉的执行，不覆盖原分支。
   * @param candidateSnapshotId - 检查点关联的不可变候选快照。
   * @throws {AppException} 快照缺失、版本不符或恢复失败，不以当前文件冒充历史。
   */
  restoreWorkspace(
    execution: SceneGenerationExecution,
    candidateSnapshotId?: string
  ): Promise<SceneGenerationWorkspace & { candidateSnapshotId?: string }>

  /**
   * 把来源线程的不可变候选复制到本操作工作区，作为修复输入。
   * 返回的修订属于本线程，不能把来源修订标识当作本工作区候选。
   * @throws {AppException} 来源修订不可读、身份不匹配或复制失败。
   */
  materializeRepairInput(
    execution: SceneGenerationExecution,
    source: SceneGenerationRepairSource
  ): Promise<SceneGenerationWorkspace & { candidateSnapshotId: string }>

  /**
   * 清理本操作的可变候选工作区，保留不可变历史快照及正式作品。
   * @throws {AppException} 清理失败，调用方保留恢复记录。
   */
  discardWorkspace(execution: SceneGenerationExecution): Promise<void>
}
