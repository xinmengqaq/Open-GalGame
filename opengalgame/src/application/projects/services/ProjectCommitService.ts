import type { ProjectOperation } from '../models/ProjectOperation'
import type { ProjectProgressListener, ProjectOperationVO } from '../vo/ProjectVO'

export interface ProjectCommitService {
  /**
   * 完成文件发布与本机登记，失败时保留可恢复事实。
   * @throws {AppException} 发布或登记失败。
   */
  commit(
    operation: ProjectOperation,
    progress?: ProjectProgressListener
  ): Promise<ProjectOperationVO>
}
