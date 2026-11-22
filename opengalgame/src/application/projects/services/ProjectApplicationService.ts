import type {
  CreateProjectDTO,
  ImportProjectDTO,
  ListProjectsDTO,
  OpenProjectDTO,
  RenameProjectDTO,
  UnregisterProjectDTO
} from '../dto/ProjectDTO'
import type { EnsureProjectWorkspaceDTO } from '../dto/ProjectWorkspaceDTO'
import type {
  ProjectListPageVO,
  ProjectProgressListener,
  ProjectOperationVO,
  ProjectSaveLocationVO,
  ProjectSummaryVO,
  UnregisterProjectVO
} from '../vo/ProjectVO'
import type { ProjectWorkspaceInspectionVO, ProjectWorkspaceVO } from '../vo/ProjectWorkspaceVO'

export interface ProjectApplicationService {
  chooseSaveLocation(): Promise<ProjectSaveLocationVO | null>

  clearSaveLocation(): void

  createProject(
    request: CreateProjectDTO,
    progress?: ProjectProgressListener
  ): Promise<ProjectOperationVO>

  importProject(
    request: ImportProjectDTO,
    progress?: ProjectProgressListener
  ): Promise<ProjectOperationVO>

  listProjects(request: ListProjectsDTO): Promise<ProjectListPageVO>

  openProject(request: OpenProjectDTO): Promise<ProjectSummaryVO>

  renameProject(request: RenameProjectDTO): Promise<ProjectSummaryVO>

  unregisterProject(request: UnregisterProjectDTO): Promise<UnregisterProjectVO>

  ensureProjectWorkspace(request: EnsureProjectWorkspaceDTO): Promise<ProjectWorkspaceVO>

  inspectProjectWorkspace(request: EnsureProjectWorkspaceDTO): Promise<ProjectWorkspaceInspectionVO>
}
