import type { ProjectListQueryGateway } from '@application/projects/ports/ProjectListQueryGateway'
import type { ProjectStorageGateway } from '@application/projects/ports/ProjectStorageGateway'
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
  ReadProjectMediaDTO,
  ReadProjectInputSourcesDTO,
  RenameProjectFileDTO,
  RenameProjectFolderDTO,
  UpdateProjectTextFileBodyDTO
} from '../../dto/ProjectFilesDTO'
import {
  toProjectFilesInspectionVO,
  toProjectInputSourcesSnapshotVO,
  toProjectInputSourceSummaryVO
} from '../../mapping/ProjectFilesViewMapper'
import type { VerifiedProjectReadLocation } from '../../models/ProjectInputSourceReadFacts'
import type { DesktopFileOpenGateway } from '../../ports/DesktopFileOpenGateway'
import type {
  ImportFileType,
  LocatedProjectFile,
  ProjectFileOperationGateway
} from '../../ports/ProjectFileOperationGateway'
import type { ProjectInputSourceReaderGateway } from '../../ports/ProjectInputSourceReaderGateway'
import type { ProjectWorkVersionGateway } from '../../ports/ProjectWorkVersionGateway'
import type { SceneCanvasArrangementReaderGateway } from '../../ports/SceneCanvasArrangementReaderGateway'
import type { ProjectFilesApplicationService } from '../ProjectFilesApplicationService'
import type {
  ProjectFolderDeletionPlanVO,
  ProjectFolderVO,
  ProjectInputCatalogVO
} from '../../vo/ProjectInputCatalogVO'
import type { ProjectFileOperationSettlementVO } from '../../vo/ProjectFileOperationVO'
import type { ProjectFilesInspectionVO } from '../../vo/ProjectFilesInspectionVO'
import type {
  ImportProjectFilesVO,
  ProjectInputSourceSummaryVO,
  ProjectInputSourcesSnapshotVO,
  ProjectInputSourceVO
} from '../../vo/ProjectInputSourceVO'
import type { ProjectMediaVO } from '../../vo/ProjectMediaVO'
import { AppException } from '@common/errors/AppException'
import { ProjectFileErrorCodes } from '@domain/project-files/errors/ProjectFileErrorCodes'
import type { ProjectInputSource } from '@domain/project-files/models/ProjectInputSource'
import { inspectProjectFileFacts } from '@domain/project-files/services/inspectProjectFileFacts'
import { validateProjectInputSources } from '@domain/project-files/services/validateProjectInputSources'
import {
  duplicateSourceIds,
  validateProjectInputSourceSummary
} from '@domain/project-files/services/validateProjectInputSourceSummary'
import { namesInParent } from '@domain/project-files/services/folderNameRules'
import { chooseImportFileName } from '@domain/project-files/services/chooseImportFileName'
import {
  copyProjectFile,
  copyProjectFolder,
  createProjectFolder,
  createProjectTextFile,
  deleteProjectFolder,
  moveProjectFile,
  place,
  readCheckedCatalog,
  readProjectFolderDeletionPlan,
  renameProjectFolder,
  storedPlacements,
  updateProjectTextFileBody
} from './projectCatalogCommands'
import { evaluateFileRename } from '@domain/project-files/services/evaluateFileRename'
import { validateRequestedSourceIds } from '@domain/project-files/services/validateRequestedSourceIds'
import { ErrorCodes } from '@common/errors/ErrorCodes'
import { Project } from '@domain/projects/models/Project'
import type { ProjectDomainService } from '@domain/projects/services/ProjectDomainService'

export interface ProjectFilesApplicationDependencies {
  listQuery: ProjectListQueryGateway
  domain: ProjectDomainService
  storage: ProjectStorageGateway
  sources: ProjectInputSourceReaderGateway
  arrangements: SceneCanvasArrangementReaderGateway
  files?: ProjectFileOperationGateway
  versions?: ProjectWorkVersionGateway
  desktopOpen?: DesktopFileOpenGateway
  createSourceId?: () => string
  createFolderId?: () => string
  createFileId?: () => string
  createOperationId?: () => string
}

/** 编排工程文件的四个只读用例。不保存、不导入、不生成。 */
export class ProjectFilesApplicationServiceImpl implements ProjectFilesApplicationService {
  private readonly deps: ProjectFilesApplicationDependencies

  constructor(deps: ProjectFilesApplicationDependencies) {
    this.deps = deps
  }

  async inspectProjectFiles(request: InspectProjectFilesDTO): Promise<ProjectFilesInspectionVO> {
    const project = await this.locateProject(request.projectId)
    const sources = await this.deps.sources.inspectProjectInputSources(project)
    const arrangements = await this.deps.arrangements.inspectSceneCanvasArrangements(project)
    assertSameProject(sources.projectId, project.projectId)
    assertSameProject(arrangements.projectId, project.projectId)
    for (const fact of arrangements.arrangements) {
      if (fact.availability === 'present')
        assertSameProject(fact.arrangement.projectId, project.projectId)
    }
    return toProjectFilesInspectionVO(
      inspectProjectFileFacts({
        projectId: project.projectId,
        inputSourceFormatSupported: sources.inputSourceFormatSupported,
        canvasArrangementFormatSupported: arrangements.canvasArrangementFormatSupported,
        sources: sources.sources,
        arrangements: arrangements.arrangements,
        catalogDamaged: sources.catalogDamaged
      })
    )
  }

  /** 扫描来源摘要。单个来源不可读仍返回；整次扫描失败则失败。 */
  async listProjectInputSources(
    request: ListProjectInputSourcesDTO
  ): Promise<ProjectInputCatalogVO> {
    const project = await this.locateProject(request.projectId)
    const catalog = await this.deps.sources.readProjectInputCatalog(project)
    const summaries = catalog.sources.map((summary) => ({
      parentFolderId: summary.parentFolderId,
      summary: validateProjectInputSourceSummary(summary)
    }))
    const duplicates = duplicateSourceIds(summaries.map((item) => item.summary.sourceId))
    return {
      projectId: project.projectId,
      catalogVersion: catalog.catalogVersion,
      folders: catalog.folders,
      sources: summaries.map((item) =>
        toProjectInputSourceSummaryVO(
          {
            ...item.summary,
            readable: item.summary.readable && !duplicates.has(item.summary.sourceId)
          },
          item.parentFolderId
        )
      )
    }
  }

  /** 读取同一窗口内与请求精确对应的来源。失败时不返回部分结果。 */
  async readProjectInputSources(
    request: ReadProjectInputSourcesDTO
  ): Promise<ProjectInputSourcesSnapshotVO> {
    validateRequestedSourceIds(request.sourceIds)
    const project = await this.locateProject(request.projectId)
    const fact = await this.deps.sources.readProjectInputSources(project, request.sourceIds)
    assertSameProject(fact.projectId, project.projectId)
    if (!sameSourceSet(request.sourceIds, fact.sources)) {
      throw new AppException({
        code: ProjectFileErrorCodes.sourceSetMismatch,
        msg: '读取到的来源与请求不一致'
      })
    }
    if (typeof fact.readVersion !== 'string' || fact.readVersion.trim() === '') {
      throw new AppException({
        code: ProjectFileErrorCodes.readFailed,
        msg: '工程文件无法读取'
      })
    }
    validateProjectInputSources(fact.sources)
    return toProjectInputSourcesSnapshotVO(project.projectId, fact.readVersion, fact.sources)
  }

  /** 只读取已登记工程中的素材字节。路径由文件端口解析。 */
  async readProjectMedia(request: ReadProjectMediaDTO): Promise<ProjectMediaVO> {
    const project = await this.locateProject(request.projectId)
    return this.requireFileOperations().files.readProjectMedia(project, request.sourceId)
  }

  /** 按选择顺序导入。一个文件失败不撤销此前已提交的文件。 */
  async importProjectFiles(request: ImportProjectFilesDTO): Promise<ImportProjectFilesVO> {
    if (request.localFilePaths.length === 0) {
      throw new AppException({ code: ErrorCodes.invalidRequest, msg: '没有选择要导入的文件' })
    }
    const project = await this.locateProject(request.projectId)
    const operations = this.requireFileOperations()
    let catalog = await readCheckedCatalog(operations, project, request.expectedCatalogVersion)
    if (
      request.parentFolderId !== null &&
      !catalog.folders.some((folder) => folder.folderId === request.parentFolderId)
    ) {
      throw new AppException({ code: ProjectFileErrorCodes.folderMissing, msg: '文件夹不存在' })
    }
    const importedFiles: ProjectInputSourceSummaryVO[] = []
    const failedFiles: ImportProjectFilesVO['failedFiles'][number][] = []
    for (const localFilePath of request.localFilePaths) {
      const inspected = await operations.files.inspectImportFile(project, localFilePath)
      if (!inspected.ok) {
        failedFiles.push({ fileName: inspected.fileName, message: inspected.message })
        continue
      }
      try {
        const fileName = chooseImportFileName(inspected.fileName, [
          ...namesInParent(catalog.folders, catalog.sources, request.parentFolderId),
          ...importedFiles.map((file) => file.name)
        ])
        const sourceId = operations.createSourceId()
        const changes = await operations.files.prepareImport(
          project,
          sourceId,
          fileName,
          localFilePath
        )
        const catalogChanges = await operations.files.prepareCatalogWrite(project, {
          folders: catalog.folders,
          placements: place(catalog, sourceId, request.parentFolderId)
        })
        await operations.versions.publish({
          project,
          operationId: operations.createOperationId(),
          changes: [...changes, ...catalogChanges.changes],
          watchedPaths: catalogChanges.watchedPaths,
          expectedCatalogVersion: catalog.catalogVersion
        })
        importedFiles.push(
          summaryOf(sourceId, fileName, inspected.fileType, request.parentFolderId)
        )
      } catch (error) {
        if (isUnclearCommit(error)) throw error
        if (process.env.OPENGALGAME_IMPORT_PROBE === '1') console.error('IMPORT_PROBE', error)
        failedFiles.push({ fileName: inspected.fileName, message: safeFileMessage(error) })
        continue
      }
      catalog = await operations.sources.readProjectInputCatalog(project)
    }
    return { importedFiles, failedFiles }
  }

  /** 按操作标识核对提交是否已经落地。不写入。 */
  async readProjectFileOperation(
    request: ReadProjectFileOperationDTO
  ): Promise<ProjectFileOperationSettlementVO> {
    const project = await this.locateProject(request.projectId)
    const operations = this.requireFileOperations()
    const settlement = await operations.versions.readOperation(project, request.operationId)
    return { operationId: request.operationId, settlement }
  }

  /** 打开已定位的工程文件。不产生作品提交。 */
  async openProjectFile(request: ProjectFileScopeDTO): Promise<void> {
    const project = await this.locateProject(request.projectId)
    const operations = this.requireFileOperations()
    const located = await operations.files.locateProjectFile(project, request.sourceId)
    await operations.desktopOpen.open(located.absolutePath)
  }

  /** 重命名文件并更新记录。名称未变化时直接返回当前摘要。 */
  async renameProjectFile(request: RenameProjectFileDTO): Promise<ProjectInputSourceSummaryVO> {
    const project = await this.locateProject(request.projectId)
    const operations = this.requireFileOperations()
    const catalog = await readCheckedCatalog(operations, project, request.expectedCatalogVersion)
    const current = catalog.sources.find((source) => source.sourceId === request.sourceId)
    const located = await operations.files.locateProjectFile(project, request.sourceId)
    const occupied = namesInParent(
      catalog.folders,
      catalog.sources,
      current?.parentFolderId ?? null,
      request.sourceId
    )
    const decision = evaluateFileRename(located.fileName, request.newFileName, occupied)
    if (!decision.changed) {
      return summaryFromLocated(located, current?.parentFolderId ?? null)
    }
    const changes = await operations.files.prepareRename(
      project,
      request.sourceId,
      decision.fileName
    )
    const catalogChanges = await operations.files.prepareCatalogWrite(project, {
      folders: catalog.folders,
      placements: storedPlacements(catalog)
    })
    await operations.versions.publish({
      project,
      operationId: operations.createOperationId(),
      changes: [...changes, ...catalogChanges.changes],
      watchedPaths: catalogChanges.watchedPaths,
      expectedCatalogVersion: catalog.catalogVersion
    })
    return summaryFromLocated(
      { ...located, fileName: decision.fileName },
      current?.parentFolderId ?? null
    )
  }

  /** 删除来源记录和仍存在的内容文件。不级联卡片。 */
  async deleteProjectFile(request: DeleteProjectFileDTO): Promise<void> {
    const project = await this.locateProject(request.projectId)
    const operations = this.requireFileOperations()
    const catalog = await readCheckedCatalog(operations, project, request.expectedCatalogVersion)
    const changes = await operations.files.prepareDelete(project, request.sourceId)
    const catalogChanges = await operations.files.prepareCatalogWrite(project, {
      folders: catalog.folders,
      placements: storedPlacements(catalog).filter(
        (placement) => placement.sourceId !== request.sourceId
      )
    })
    await operations.versions.publish({
      project,
      operationId: operations.createOperationId(),
      changes: [...changes, ...catalogChanges.changes],
      watchedPaths: catalogChanges.watchedPaths,
      expectedCatalogVersion: catalog.catalogVersion
    })
  }

  createProjectTextFile(request: CreateProjectTextFileDTO): Promise<ProjectInputSourceSummaryVO> {
    return this.withCatalogCommand(request.projectId, (project, operations) =>
      createProjectTextFile(operations, project, request)
    )
  }

  async updateProjectTextFileBody(
    request: UpdateProjectTextFileBodyDTO
  ): Promise<ProjectInputSourceVO> {
    validateRequestedSourceIds([request.sourceId])
    if (
      typeof request.expectedSourceVersion !== 'string' ||
      request.expectedSourceVersion.trim() === ''
    ) {
      throw new AppException({
        code: ProjectFileErrorCodes.blankSourceVersion,
        msg: '来源版本不能为空'
      })
    }
    return this.withCatalogCommand(request.projectId, (project, operations) =>
      updateProjectTextFileBody(operations, project, request)
    )
  }

  createProjectFolder(request: CreateProjectFolderDTO): Promise<ProjectFolderVO> {
    return this.withCatalogCommand(request.projectId, (project, operations) =>
      createProjectFolder(operations, project, request)
    )
  }

  copyProjectFile(request: CopyProjectFileDTO): Promise<ProjectInputSourceSummaryVO> {
    return this.withCatalogCommand(request.projectId, (project, operations) =>
      copyProjectFile(operations, project, request)
    )
  }

  moveProjectFile(request: MoveProjectFileDTO): Promise<ProjectInputSourceSummaryVO> {
    return this.withCatalogCommand(request.projectId, (project, operations) =>
      moveProjectFile(operations, project, request)
    )
  }

  copyProjectFolder(request: CopyProjectFolderDTO): Promise<ProjectFolderVO> {
    return this.withCatalogCommand(request.projectId, (project, operations) =>
      copyProjectFolder(operations, project, request)
    )
  }

  renameProjectFolder(request: RenameProjectFolderDTO): Promise<ProjectFolderVO> {
    return this.withCatalogCommand(request.projectId, (project, operations) =>
      renameProjectFolder(operations, project, request)
    )
  }

  readProjectFolderDeletionPlan(
    request: ProjectFolderScopeDTO
  ): Promise<ProjectFolderDeletionPlanVO> {
    return this.withCatalogCommand(request.projectId, (project, operations) =>
      readProjectFolderDeletionPlan(operations, project, request)
    )
  }

  deleteProjectFolder(request: DeleteProjectFolderDTO): Promise<void> {
    return this.withCatalogCommand(request.projectId, (project, operations) =>
      deleteProjectFolder(operations, project, request)
    )
  }

  /**
   * @throws {AppException} 工程未登记、未初始化或身份不一致。
   */
  private async locateProject(projectId: string): Promise<VerifiedProjectReadLocation> {
    const registration = await this.deps.listQuery.findRegistration(projectId)
    this.deps.domain.requireRegistered(registration)
    const inspection = await this.deps.storage.inspect({ directory: registration.directory })
    const project = Project.restoreRegisteredProject({
      workspace: inspection,
      identity: { id: registration.id }
    })
    return { projectId: project.id, location: { directory: registration.directory } }
  }

  private requireFileOperations(): {
    files: ProjectFileOperationGateway
    versions: ProjectWorkVersionGateway
    desktopOpen: DesktopFileOpenGateway
    sources: ProjectInputSourceReaderGateway
    createSourceId: () => string
    createFolderId: () => string
    createFileId: () => string
    createOperationId: () => string
  } {
    const {
      files,
      versions,
      desktopOpen,
      sources,
      createSourceId,
      createFolderId,
      createFileId,
      createOperationId
    } = this.deps
    if (!files || !versions || !desktopOpen || !createSourceId || !createOperationId) {
      throw new AppException({
        code: ProjectFileErrorCodes.fileOperationFailed,
        msg: '工程文件操作尚未装配'
      })
    }
    return {
      files,
      versions,
      desktopOpen,
      sources,
      createSourceId,
      createFolderId: createFolderId ?? createSourceId,
      createFileId: createFileId ?? createSourceId,
      createOperationId
    }
  }

  private async withCatalogCommand<T>(
    projectId: string,
    command: (
      project: VerifiedProjectReadLocation,
      operations: ReturnType<ProjectFilesApplicationServiceImpl['requireFileOperations']>
    ) => Promise<T>
  ): Promise<T> {
    const project = await this.locateProject(projectId)
    return command(project, this.requireFileOperations())
  }
}

function summaryOf(
  sourceId: string,
  fileName: string,
  fileType: ImportFileType,
  parentFolderId: string | null
): ProjectInputSourceSummaryVO {
  if (fileType === 'document') {
    return {
      sourceId,
      name: fileName,
      readable: true,
      parentFolderId,
      contentKind: 'text',
      textKind: 'document'
    }
  }
  return { sourceId, name: fileName, readable: true, parentFolderId, contentKind: fileType }
}

function summaryFromLocated(
  located: LocatedProjectFile,
  parentFolderId: string | null
): ProjectInputSourceSummaryVO {
  if (located.contentKind === 'text') {
    return {
      sourceId: located.sourceId,
      name: located.fileName,
      readable: located.readable,
      parentFolderId,
      contentKind: 'text',
      textKind: located.textKind ?? 'document'
    }
  }
  return {
    sourceId: located.sourceId,
    name: located.fileName,
    readable: located.readable,
    parentFolderId,
    contentKind: located.contentKind
  }
}

function isUnclearCommit(error: unknown): boolean {
  return error instanceof AppException && error.code === ProjectFileErrorCodes.commitUnclear
}

function safeFileMessage(error: unknown): string {
  if (error instanceof AppException) return error.message
  return '文件操作失败'
}

function assertSameProject(actual: string, expected: string): void {
  if (actual !== expected) {
    throw new AppException({
      code: ProjectFileErrorCodes.ownershipMismatch,
      msg: '工程文件归属不匹配'
    })
  }
}

function sameSourceSet(
  requested: readonly string[],
  sources: readonly ProjectInputSource[]
): boolean {
  if (requested.length !== sources.length) return false
  const returned = sources.map((source) => source.sourceId)
  if (new Set(returned).size !== returned.length) return false
  const expected = new Set(requested)
  return returned.every((sourceId) => expected.has(sourceId))
}
