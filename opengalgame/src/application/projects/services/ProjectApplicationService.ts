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
  /**
   * @returns 选中的目录；取消为 null。
   */
  chooseSaveLocation(): Promise<ProjectSaveLocationVO | null>

  clearSaveLocation(): void

  /**
   * @returns 完成或取消结果。
   */
  createProject(
    request: CreateProjectDTO,
    progress?: ProjectProgressListener
  ): Promise<ProjectOperationVO>

  /**
   * @returns 完成或取消结果。
   */
  importProject(
    request: ImportProjectDTO,
    progress?: ProjectProgressListener
  ): Promise<ProjectOperationVO>

  listProjects(request: ListProjectsDTO): Promise<ProjectListPageVO>

  openProject(request: OpenProjectDTO): Promise<ProjectSummaryVO>

  renameProject(request: RenameProjectDTO): Promise<ProjectSummaryVO>

  /** 从本机列表移出登记，不删除工程文件。 */
  unregisterProject(request: UnregisterProjectDTO): Promise<UnregisterProjectVO>

  /**
   * 核对已登记工程的默认场景和作品基线。
   * @throws {AppException} 工程未登记或初始化未完成。
   */
  ensureProjectWorkspace(request: EnsureProjectWorkspaceDTO): Promise<ProjectWorkspaceVO>

  /**
   * 只读检查已登记工程的仓库、基线、场景脚本、锁和身份。不写盘。
   * @throws {AppException} 工程未登记，或工作区无法安全读取。
   */
  inspectProjectWorkspace(request: EnsureProjectWorkspaceDTO): Promise<ProjectWorkspaceInspectionVO>
}
