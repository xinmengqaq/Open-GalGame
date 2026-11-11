import type {
  CreateProjectDTO,
  ImportProjectDTO,
  ListProjectsDTO,
  OpenProjectDTO,
  RenameProjectDTO,
  UnregisterProjectDTO
} from '@application/projects/dto/ProjectDTO'
import type { EnsureProjectWorkspaceDTO } from '@application/projects/dto/ProjectWorkspaceDTO'
import type {
  ProjectListPageVO,
  ProjectProgressVO,
  ProjectOperationVO,
  ProjectSaveLocationVO,
  ProjectSummaryVO,
  UnregisterProjectVO
} from '@application/projects/vo/ProjectVO'
import type {
  ProjectWorkspaceInspectionVO,
  ProjectWorkspaceVO
} from '@application/projects/vo/ProjectWorkspaceVO'
import type { AjaxResult } from '@common/contracts/AjaxResult'

export interface ProjectClient {
  chooseSaveLocation(): Promise<AjaxResult<ProjectSaveLocationVO | null>>
  clearSaveLocation(): Promise<AjaxResult<null>>
  createProject(
    request: CreateProjectDTO,
    listener?: (progress: ProjectProgressVO) => void
  ): Promise<AjaxResult<ProjectOperationVO>>
  importProject(
    request: ImportProjectDTO,
    listener?: (progress: ProjectProgressVO) => void
  ): Promise<AjaxResult<ProjectOperationVO>>
  listProjects(request: ListProjectsDTO): Promise<AjaxResult<ProjectListPageVO>>
  openProject(request: OpenProjectDTO): Promise<AjaxResult<ProjectSummaryVO>>
  renameProject(request: RenameProjectDTO): Promise<AjaxResult<ProjectSummaryVO>>
  unregisterProject(request: UnregisterProjectDTO): Promise<AjaxResult<UnregisterProjectVO>>
  /** 核对已登记工程的默认场景和作品基线。 */
  ensureProjectWorkspace(
    request: EnsureProjectWorkspaceDTO
  ): Promise<AjaxResult<ProjectWorkspaceVO>>
  /** 只读检查已登记工程的工作区，不补建。 */
  inspectProjectWorkspace(
    request: EnsureProjectWorkspaceDTO
  ): Promise<AjaxResult<ProjectWorkspaceInspectionVO>>
}
