import type { EnsureProjectWorkspaceDTO } from '../dto/ProjectWorkspaceDTO'
import type { ProjectWorkspaceInspectionVO, ProjectWorkspaceVO } from '../vo/ProjectWorkspaceVO'

/**
 * 核对已登记工程的默认场景、场景文件和作品基线。
 * ensure 只由工程创建、导入、没有画布身份的首次打开、显式重新构建和启动生成调用。
 * 打开已有身份、画布保存前检查、状态、历史和输入读取只调用 inspect，不得写盘。
 */
export interface ProjectWorkspaceService {
  /**
   * 幂等核对工作区。重复调用不覆盖已有内容，也不新增无变化的提交。
   * 只补缺失。损坏的锁或仓库不静默覆盖。
   * @throws {AppException} 工程初始化未完成。消息不含路径、版本输出或锁内容。
   */
  ensureProjectWorkspace(request: EnsureProjectWorkspaceDTO): Promise<ProjectWorkspaceVO>

  /**
   * 只读检查仓库、HEAD、声明基线、场景脚本、锁和身份。不写盘。
   * 身份尚未写入时不返回 sceneId/canvasId。
   * @throws {AppException} 工程身份不正确，或工作区无法安全读取。消息不含路径或内部细节。
   */
  inspectProjectWorkspace(request: EnsureProjectWorkspaceDTO): Promise<ProjectWorkspaceInspectionVO>
}
