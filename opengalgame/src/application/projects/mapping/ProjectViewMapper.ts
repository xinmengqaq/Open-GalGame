import type { ProjectLocation } from '../models/ProjectLocation'
import type { ProjectOperation } from '../models/ProjectOperation'
import type { ProjectOperationVO, ProjectSaveLocationVO, ProjectSummaryVO } from '../vo/ProjectVO'
import type { Project } from '@domain/projects/models/Project'

/** 提取可公开的项目摘要，不暴露领域事件。 */
export function toProjectSummaryVO(project: Project): ProjectSummaryVO {
  return { id: project.id, name: project.name, synopsis: project.synopsis }
}

/** 从已完成的操作事实提取结果，不暴露目录和恢复记录。 */
export function toProjectOperationVO(operation: ProjectOperation): ProjectOperationVO {
  return { status: 'completed', projectId: operation.project.id, name: operation.project.name }
}

/** 映射保存位置，取消选择时保留空结果。 */
export function toProjectSaveLocationVO(
  location: ProjectLocation | null
): ProjectSaveLocationVO | null {
  return location ? { directory: location.directory } : null
}
