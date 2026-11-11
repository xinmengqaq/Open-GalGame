import type {
  CopyProjectFileDTO,
  CopyProjectFolderDTO,
  CreateProjectFolderDTO,
  CreateProjectTextFileDTO,
  DeleteProjectFileDTO,
  DeleteProjectFolderDTO,
  ImportProjectFilesDTO,
  InspectProjectFilesDTO,
  ListProjectInputSourcesDTO,
  MoveProjectFileDTO,
  ProjectFileScopeDTO,
  ProjectFolderScopeDTO,
  ReadProjectFileOperationDTO,
  ReadProjectInputSourcesDTO,
  ReadProjectMediaDTO,
  RenameProjectFileDTO,
  RenameProjectFolderDTO,
  UpdateProjectTextFileBodyDTO
} from '@application/project-files/dto/ProjectFilesDTO'
import type { ProjectFileOperationSettlementVO } from '@application/project-files/vo/ProjectFileOperationVO'
import type { ProjectFilesInspectionVO } from '@application/project-files/vo/ProjectFilesInspectionVO'
import type {
  ProjectFolderDeletionPlanVO,
  ProjectFolderVO,
  ProjectInputCatalogVO
} from '@application/project-files/vo/ProjectInputCatalogVO'
import type { ProjectMediaVO } from '@application/project-files/vo/ProjectMediaVO'
import type {
  ImportProjectFilesVO,
  ProjectInputSourceSummaryVO,
  ProjectInputSourcesSnapshotVO,
  ProjectInputSourceVO
} from '@application/project-files/vo/ProjectInputSourceVO'
import type { AjaxResult } from '@common/contracts/AjaxResult'

export interface ProjectFilesClient {
  /**
   * @returns 检查结果。成功只表示检查完成，诊断仍在结果中。
   */
  inspectProjectFiles(
    request: InspectProjectFilesDTO
  ): Promise<AjaxResult<ProjectFilesInspectionVO>>

  /**
   * @returns 来源摘要。成功空列表表示没有来源，不是扫描失败。
   */
  listProjectInputSources(
    request: ListProjectInputSourcesDTO
  ): Promise<AjaxResult<ProjectInputCatalogVO>>

  /**
   * @returns 完整来源快照。失败响应不携带部分来源。
   */
  readProjectInputSources(
    request: ReadProjectInputSourcesDTO
  ): Promise<AjaxResult<ProjectInputSourcesSnapshotVO>>

  /** 按来源身份读取媒体字节。失败响应不携带部分字节。 */
  readProjectMedia(request: ReadProjectMediaDTO): Promise<AjaxResult<ProjectMediaVO>>

  /**
   * 选择待导入文件。取消时 data 为 null。
   * @returns 路径列表或取消。
   */
  chooseProjectFiles(): Promise<AjaxResult<readonly string[] | null>>

  /**
   * @returns 成功项和失败项。
   */
  importProjectFiles(request: ImportProjectFilesDTO): Promise<AjaxResult<ImportProjectFilesVO>>

  /**
   * 用系统默认程序打开工程文件。
   * @returns 成功时 data 为 null。
   */
  openProjectFile(request: ProjectFileScopeDTO): Promise<AjaxResult<null>>

  renameProjectFile(request: RenameProjectFileDTO): Promise<AjaxResult<ProjectInputSourceSummaryVO>>

  /**
   * @returns 成功时 data 为 null。
   */
  deleteProjectFile(request: DeleteProjectFileDTO): Promise<AjaxResult<null>>

  createProjectTextFile(
    request: CreateProjectTextFileDTO
  ): Promise<AjaxResult<ProjectInputSourceSummaryVO>>

  /**
   * 覆盖文档正文。
   * @returns 保存后的来源详情，含新版本和正文。
   */
  updateProjectTextFileBody(
    request: UpdateProjectTextFileBodyDTO
  ): Promise<AjaxResult<ProjectInputSourceVO>>

  createProjectFolder(request: CreateProjectFolderDTO): Promise<AjaxResult<ProjectFolderVO>>

  copyProjectFile(request: CopyProjectFileDTO): Promise<AjaxResult<ProjectInputSourceSummaryVO>>

  moveProjectFile(request: MoveProjectFileDTO): Promise<AjaxResult<ProjectInputSourceSummaryVO>>

  copyProjectFolder(request: CopyProjectFolderDTO): Promise<AjaxResult<ProjectFolderVO>>

  renameProjectFolder(request: RenameProjectFolderDTO): Promise<AjaxResult<ProjectFolderVO>>

  readProjectFolderDeletionPlan(
    request: ProjectFolderScopeDTO
  ): Promise<AjaxResult<ProjectFolderDeletionPlanVO>>

  deleteProjectFolder(request: DeleteProjectFolderDTO): Promise<AjaxResult<null>>

  /**
   * @returns 已提交、未提交，或仍不能判定。
   */
  readProjectFileOperation(
    request: ReadProjectFileOperationDTO
  ): Promise<AjaxResult<ProjectFileOperationSettlementVO>>

  /**
   * 把拖入的磁盘文件转成本机路径。不经过导入通道。
   * @returns 路径。不是磁盘文件时失败。
   */
  pathForDroppedFile(file: File): Promise<AjaxResult<string>>
}
