import type {
  SceneGenerationExecution,
  SceneGenerationWorkspace
} from '../models/SceneGenerationExecution'
import type { SceneGenerationRepairSource } from '../vo/SceneGenerationVO'

export interface SceneGenerationWorkspaceGateway {
  createWorkspace(execution: SceneGenerationExecution): Promise<SceneGenerationWorkspace>

  restoreWorkspace(
    execution: SceneGenerationExecution,
    candidateSnapshotId?: string
  ): Promise<SceneGenerationWorkspace & { candidateSnapshotId?: string }>

  /**
   * 只核对已物化的修复输入是否仍等于来源不可变草稿；不创建目录、不写文件。
   * 用于写入恢复门之前把“已证明的修复输入”与“候选写入”分开。
   * @returns 本操作可复用的输入修订与工作区；证据不足时为 undefined。
   */
  proveRepairInput(
    execution: SceneGenerationExecution,
    source: SceneGenerationRepairSource
  ): Promise<(SceneGenerationWorkspace & { candidateSnapshotId: string }) | undefined>

  /**
   * 把来源线程的不可变候选复制到本操作工作区，作为修复输入。
   * 来源草稿已存在且逐字节一致时复用本操作的可变工作区与已发布修订，
   * 不重复建目录，也不清理无法证明的现场；返回的修订属于本线程。
   * @throws {AppException | SceneGenerationWriteOutcomeUnknown} 来源修订不可读、身份不匹配、
   * 既有现场与来源不一致或复制失败。
   */
  materializeRepairInput(
    execution: SceneGenerationExecution,
    source: SceneGenerationRepairSource
  ): Promise<SceneGenerationWorkspace & { candidateSnapshotId: string }>

  discardWorkspace(execution: SceneGenerationExecution): Promise<void>
}
