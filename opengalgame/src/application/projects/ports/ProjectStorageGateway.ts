import type { ProjectLocation } from '../models/ProjectLocation'
import type { ProjectOperation } from '../models/ProjectOperation'
import type { Project } from '@domain/projects/models/Project'
import type { WorkspaceInspection } from '@domain/projects/models/ProjectWorkspace'

export interface ProjectStorageGateway {
  inspect(location: ProjectLocation): Promise<WorkspaceInspection>

  initialize(operation: ProjectOperation): Promise<void>

  isPublished(operation: ProjectOperation): Promise<boolean>

  /**
   * @param operation - 暂存所属操作。
   */
  discard(operation: ProjectOperation): Promise<void>

  /**
   * 把已合法项目写回已有工程信息文件。不初始化工程或管理目录。
   * @returns 写入事实；内容不在时为 missing，不抛业务异常。
   */
  saveProjectInfo(location: ProjectLocation, project: Project): Promise<'saved' | 'missing'>
}
