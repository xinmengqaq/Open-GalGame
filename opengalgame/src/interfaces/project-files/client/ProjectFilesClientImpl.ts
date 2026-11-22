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
import { communicationFailureResult } from '../../client/communicationFailure'
import type { DesktopBridge } from '../../client/DesktopBridge'
import {
  parseChosenProjectFilesResult,
  parseDroppedFilePathResult,
  parseImportProjectFilesResult,
  parseProjectFileNullResult,
  parseProjectFilesInspectionResult,
  parseProjectFileOperationResult,
  parseProjectFileOperationsRecoveryResult,
  parseProjectFolderDeletionPlanResult,
  parseProjectFolderResult,
  parseProjectInputSourceListResult,
  parseProjectInputSourceResult,
  parseProjectInputSourcesSnapshotResult,
  parseProjectMediaResult,
  parseRenamedProjectFileResult
} from '../contracts/ProjectFilesResponseSchema'
import type { ProjectFilesClient } from './ProjectFilesClient'

async function readProjectFilesResult<T>(
  action: () => Promise<unknown>,
  parse: (value: unknown) => AjaxResult<T> | null
): Promise<AjaxResult<T>> {
  try {
    const result = parse(await action())
    return result ?? communicationFailureResult()
  } catch {
    return communicationFailureResult()
  }
}

export class ProjectFilesClientImpl implements ProjectFilesClient {
  constructor(private readonly bridge: DesktopBridge) {}

  inspectProjectFiles(
    request: InspectProjectFilesDTO
  ): Promise<AjaxResult<ProjectFilesInspectionVO>> {
    return readProjectFilesResult(
      () => this.bridge.inspectProjectFiles(request),
      parseProjectFilesInspectionResult
    )
  }

  listProjectInputSources(
    request: ListProjectInputSourcesDTO
  ): Promise<AjaxResult<ProjectInputCatalogVO>> {
    return readProjectFilesResult(
      () => this.bridge.listProjectInputSources(request),
      parseProjectInputSourceListResult
    )
  }

  readProjectInputSources(
    request: ReadProjectInputSourcesDTO
  ): Promise<AjaxResult<ProjectInputSourcesSnapshotVO>> {
    return readProjectFilesResult(
      () => this.bridge.readProjectInputSources(request),
      parseProjectInputSourcesSnapshotResult
    )
  }

  readProjectMedia(request: ReadProjectMediaDTO): Promise<AjaxResult<ProjectMediaVO>> {
    return readProjectFilesResult(
      () => this.bridge.readProjectMedia(request),
      parseProjectMediaResult
    )
  }

  chooseProjectFiles(): Promise<AjaxResult<readonly string[] | null>> {
    return readProjectFilesResult(
      () => this.bridge.chooseProjectFiles(),
      parseChosenProjectFilesResult
    )
  }

  importProjectFiles(request: ImportProjectFilesDTO): Promise<AjaxResult<ImportProjectFilesVO>> {
    return readProjectFilesResult(
      () => this.bridge.importProjectFiles(request),
      parseImportProjectFilesResult
    )
  }

  openProjectFile(request: ProjectFileScopeDTO): Promise<AjaxResult<null>> {
    return readProjectFilesResult(
      () => this.bridge.openProjectFile(request),
      parseProjectFileNullResult
    )
  }

  renameProjectFile(
    request: RenameProjectFileDTO
  ): Promise<AjaxResult<ProjectInputSourceSummaryVO>> {
    return readProjectFilesResult(
      () => this.bridge.renameProjectFile(request),
      parseRenamedProjectFileResult
    )
  }

  deleteProjectFile(request: DeleteProjectFileDTO): Promise<AjaxResult<null>> {
    return readProjectFilesResult(
      () => this.bridge.deleteProjectFile(request),
      parseProjectFileNullResult
    )
  }

  createProjectTextFile(
    request: CreateProjectTextFileDTO
  ): Promise<AjaxResult<ProjectInputSourceSummaryVO>> {
    return readProjectFilesResult(
      () => this.bridge.createProjectTextFile(request),
      parseRenamedProjectFileResult
    )
  }

  updateProjectTextFileBody(
    request: UpdateProjectTextFileBodyDTO
  ): Promise<AjaxResult<ProjectInputSourceVO>> {
    return readProjectFilesResult(
      () => this.bridge.updateProjectTextFileBody(request),
      parseProjectInputSourceResult
    )
  }

  createProjectFolder(request: CreateProjectFolderDTO): Promise<AjaxResult<ProjectFolderVO>> {
    return readProjectFilesResult(
      () => this.bridge.createProjectFolder(request),
      parseProjectFolderResult
    )
  }

  copyProjectFile(request: CopyProjectFileDTO): Promise<AjaxResult<ProjectInputSourceSummaryVO>> {
    return readProjectFilesResult(
      () => this.bridge.copyProjectFile(request),
      parseRenamedProjectFileResult
    )
  }

  moveProjectFile(request: MoveProjectFileDTO): Promise<AjaxResult<ProjectInputSourceSummaryVO>> {
    return readProjectFilesResult(
      () => this.bridge.moveProjectFile(request),
      parseRenamedProjectFileResult
    )
  }

  copyProjectFolder(request: CopyProjectFolderDTO): Promise<AjaxResult<ProjectFolderVO>> {
    return readProjectFilesResult(
      () => this.bridge.copyProjectFolder(request),
      parseProjectFolderResult
    )
  }

  renameProjectFolder(request: RenameProjectFolderDTO): Promise<AjaxResult<ProjectFolderVO>> {
    return readProjectFilesResult(
      () => this.bridge.renameProjectFolder(request),
      parseProjectFolderResult
    )
  }

  readProjectFolderDeletionPlan(
    request: ProjectFolderScopeDTO
  ): Promise<AjaxResult<ProjectFolderDeletionPlanVO>> {
    return readProjectFilesResult(
      () => this.bridge.readProjectFolderDeletionPlan(request),
      parseProjectFolderDeletionPlanResult
    )
  }

  deleteProjectFolder(request: DeleteProjectFolderDTO): Promise<AjaxResult<null>> {
    return readProjectFilesResult(
      () => this.bridge.deleteProjectFolder(request),
      parseProjectFileNullResult
    )
  }

  readProjectFileOperation(
    request: ReadProjectFileOperationDTO
  ): Promise<AjaxResult<ProjectFileOperationSettlementVO>> {
    return readProjectFilesResult(
      () => this.bridge.readProjectFileOperation(request),
      parseProjectFileOperationResult
    )
  }

  recoverProjectFileOperations(
    request: RecoverProjectFileOperationsDTO
  ): Promise<AjaxResult<readonly ProjectFileOperationRecoveryVO[]>> {
    return readProjectFilesResult(
      () => this.bridge.recoverProjectFileOperations(request),
      parseProjectFileOperationsRecoveryResult
    )
  }

  pathForDroppedFile(file: File): Promise<AjaxResult<string>> {
    return readProjectFilesResult(
      () => this.bridge.pathForDroppedFile(file),
      parseDroppedFilePathResult
    )
  }
}
