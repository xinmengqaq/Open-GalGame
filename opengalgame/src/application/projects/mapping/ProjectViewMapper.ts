import type { ProjectLocation } from '../models/ProjectLocation'
import type { ProjectOperation } from '../models/ProjectOperation'
import type { ProjectOperationVO, ProjectSaveLocationVO, ProjectSummaryVO } from '../vo/ProjectVO'
import type { Project } from '@domain/projects/models/Project'

export function toProjectSummaryVO(project: Project): ProjectSummaryVO {
  return { id: project.id, name: project.name, synopsis: project.synopsis }
}

export function toProjectOperationVO(operation: ProjectOperation): ProjectOperationVO {
  return { status: 'completed', projectId: operation.project.id, name: operation.project.name }
}

export function toProjectSaveLocationVO(
  location: ProjectLocation | null
): ProjectSaveLocationVO | null {
  return location ? { directory: location.directory } : null
}
