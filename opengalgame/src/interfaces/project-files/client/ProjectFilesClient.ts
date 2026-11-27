import type {
  ChooseProjectFilesDTO,
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
  RecoverProjectFileOperationsDTO,
  ReadProjectInputSourcesDTO,
  ReadProjectMediaDTO,
  RenameProjectFileDTO,
  RenameProjectFolderDTO,
  UpdateProjectTextFileBodyDTO
} from '@application/project-files/dto/ProjectFilesDTO'
import type {
  ProjectFileOperationRecoveryVO,
  ProjectFileOperationSettlementVO
} from '@application/project-files/vo/ProjectFileOperationVO'
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
  inspectProjectFiles(
    request: InspectProjectFilesDTO
  ): Promise<AjaxResult<ProjectFilesInspectionVO>>

  listProjectInputSources(
    request: ListProjectInputSourcesDTO
  ): Promise<AjaxResult<ProjectInputCatalogVO>>

  readProjectInputSources(
    request: ReadProjectInputSourcesDTO
  ): Promise<AjaxResult<ProjectInputSourcesSnapshotVO>>

  readProjectMedia(request: ReadProjectMediaDTO): Promise<AjaxResult<ProjectMediaVO>>

  chooseProjectFiles(
    request?: ChooseProjectFilesDTO
  ): Promise<AjaxResult<readonly string[] | null>>

  importProjectFiles(request: ImportProjectFilesDTO): Promise<AjaxResult<ImportProjectFilesVO>>

  openProjectFile(request: ProjectFileScopeDTO): Promise<AjaxResult<null>>

  renameProjectFile(request: RenameProjectFileDTO): Promise<AjaxResult<ProjectInputSourceSummaryVO>>

  deleteProjectFile(request: DeleteProjectFileDTO): Promise<AjaxResult<null>>

  createProjectTextFile(
    request: CreateProjectTextFileDTO
  ): Promise<AjaxResult<ProjectInputSourceSummaryVO>>

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

  readProjectFileOperation(
    request: ReadProjectFileOperationDTO
  ): Promise<AjaxResult<ProjectFileOperationSettlementVO>>

  recoverProjectFileOperations(
    request: RecoverProjectFileOperationsDTO
  ): Promise<AjaxResult<readonly ProjectFileOperationRecoveryVO[]>>

  pathForDroppedFile(file: File): Promise<AjaxResult<string>>
}
