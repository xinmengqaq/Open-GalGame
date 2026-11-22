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
  RecoverProjectFileOperationsDTO,
  ReadProjectInputSourcesDTO,
  ReadProjectMediaDTO,
  RenameProjectFileDTO,
  RenameProjectFolderDTO,
  UpdateProjectTextFileBodyDTO
} from '../dto/ProjectFilesDTO'
import type {
  ProjectFileOperationRecoveryVO,
  ProjectFileOperationSettlementVO
} from '../vo/ProjectFileOperationVO'
import type { ProjectMediaVO } from '../vo/ProjectMediaVO'
import type { ProjectFilesInspectionVO } from '../vo/ProjectFilesInspectionVO'
import type {
  ProjectFolderDeletionPlanVO,
  ProjectFolderVO,
  ProjectInputCatalogVO
} from '../vo/ProjectInputCatalogVO'
import type {
  ImportProjectFilesVO,
  ProjectInputSourceSummaryVO,
  ProjectInputSourcesSnapshotVO,
  ProjectInputSourceVO
} from '../vo/ProjectInputSourceVO'

export interface ProjectFilesApplicationService {
  inspectProjectFiles(request: InspectProjectFilesDTO): Promise<ProjectFilesInspectionVO>

  listProjectInputSources(request: ListProjectInputSourcesDTO): Promise<ProjectInputCatalogVO>

  readProjectInputSources(
    request: ReadProjectInputSourcesDTO
  ): Promise<ProjectInputSourcesSnapshotVO>

  readProjectMedia(request: ReadProjectMediaDTO): Promise<ProjectMediaVO>

  importProjectFiles(request: ImportProjectFilesDTO): Promise<ImportProjectFilesVO>

  openProjectFile(request: ProjectFileScopeDTO): Promise<void>

  renameProjectFile(request: RenameProjectFileDTO): Promise<ProjectInputSourceSummaryVO>

  deleteProjectFile(request: DeleteProjectFileDTO): Promise<void>

  createProjectTextFile(request: CreateProjectTextFileDTO): Promise<ProjectInputSourceSummaryVO>

  updateProjectTextFileBody(request: UpdateProjectTextFileBodyDTO): Promise<ProjectInputSourceVO>

  createProjectFolder(request: CreateProjectFolderDTO): Promise<ProjectFolderVO>

  copyProjectFile(request: CopyProjectFileDTO): Promise<ProjectInputSourceSummaryVO>

  moveProjectFile(request: MoveProjectFileDTO): Promise<ProjectInputSourceSummaryVO>

  copyProjectFolder(request: CopyProjectFolderDTO): Promise<ProjectFolderVO>

  renameProjectFolder(request: RenameProjectFolderDTO): Promise<ProjectFolderVO>

  readProjectFolderDeletionPlan(
    request: ProjectFolderScopeDTO
  ): Promise<ProjectFolderDeletionPlanVO>

  readProjectFileOperation(
    request: ReadProjectFileOperationDTO
  ): Promise<ProjectFileOperationSettlementVO>

  recoverProjectFileOperations(
    request: RecoverProjectFileOperationsDTO
  ): Promise<readonly ProjectFileOperationRecoveryVO[]>

  deleteProjectFolder(request: DeleteProjectFolderDTO): Promise<void>
}
