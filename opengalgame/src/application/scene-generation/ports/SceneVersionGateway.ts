import type { ProjectWorkspaceVO } from '@application/projects/vo/ProjectWorkspaceVO'
import type {
  SceneGenerationBaseline,
  SceneGenerationCandidate,
  SceneGenerationCommitState,
  SceneGenerationExecution,
  SceneGenerationVersionFacts
} from '../models/SceneGenerationExecution'
import type { SceneSourceLocation } from '../../scenes/models/SceneSourceLocation'

export interface SceneVersionGateway {
  /**
   * 读取正式场景基线及锁定事实，不修改或修复作品。
   * @throws {AppException} 无法取得可靠基线。
   */
  readBaseline(source: SceneSourceLocation): Promise<SceneGenerationBaseline>

  /**
   * 启动生成前核对作品仓库、默认场景和锁。只补缺失，不读取或修复查询路径。
   * @throws {AppException} 工程初始化未完成。
   */
  ensureWorkspace(projectId: string): Promise<ProjectWorkspaceVO>

  /**
   * 重新读取受影响正式文件，报告相对本操作基线的变化和当前锁定事实。
   * @returns 供领域判断的覆盖事实，不决定是否允许覆盖。
   * @throws {AppException} 读取失败。
   */
  inspectBaseline(execution: SceneGenerationExecution): Promise<SceneGenerationVersionFacts>

  /**
   * 在短提交边界内重新核对事实并调用领域检查，再原子提交真实脚本与明确素材变更。
   * 同一 operationId 幂等；未通过检查不得写正式文件，不持有生成或等待期间的锁。
   * @throws {AppException} 领域拒绝覆盖或提交失败；结果不明可按操作查询。
   */
  commitCandidate(
    execution: SceneGenerationExecution,
    candidate: SceneGenerationCandidate,
    requireVersion: (facts: SceneGenerationVersionFacts) => void
  ): Promise<{ commitId: string }>

  /**
   * 查询本操作的持久提交事实，不因查询清理、重提或回退。
   * @returns 已提交、未提交、需要受控回退或结果不明。
   * @throws {AppException} 核对失败。
   */
  readOperationCommit(execution: SceneGenerationExecution): Promise<SceneGenerationCommitState>

  /**
   * 恢复本操作明确修改集，保留其他人工修改与既有提交历史。
   * @param commitId - 经核对需要回退的本操作修订。
   * @returns 回退修订标识。
   * @throws {AppException} 回退失败，调用方同时保留原始失败。
   */
  rollbackCandidate(
    execution: SceneGenerationExecution,
    commitId: string
  ): Promise<{ rollbackCommitId: string }>
}
