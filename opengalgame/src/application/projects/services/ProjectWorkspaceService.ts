import type { EnsureProjectWorkspaceDTO } from '../dto/ProjectWorkspaceDTO'
import type { ProjectWorkspaceInspectionVO, ProjectWorkspaceVO } from '../vo/ProjectWorkspaceVO'

export interface ProjectWorkspaceService {
  ensureProjectWorkspace(request: EnsureProjectWorkspaceDTO): Promise<ProjectWorkspaceVO>

  inspectProjectWorkspace(request: EnsureProjectWorkspaceDTO): Promise<ProjectWorkspaceInspectionVO>
}
