import type {
  CreateProjectDTO,
  ImportProjectDTO,
  ListProjectsDTO,
  OpenProjectDTO,
  RenameProjectDTO,
  UnregisterProjectDTO
} from '../../dto/ProjectDTO'
import type { EnsureProjectWorkspaceDTO } from '../../dto/ProjectWorkspaceDTO'
import {
  toProjectOperationVO,
  toProjectSaveLocationVO,
  toProjectSummaryVO
} from '../../mapping/ProjectViewMapper'
import type { ProjectOperation } from '../../models/ProjectOperation'
import {
  createProjectFingerprint,
  importProjectFingerprint
} from '../../policies/ProjectIdempotency'
import type { ProjectExecutionGateway } from '../../ports/ProjectExecutionGateway'
import type { ProjectFileDialogGateway } from '../../ports/ProjectFileDialogGateway'
import type {
  ProjectListQueryGateway,
  ProjectRegistrationRecord
} from '../../ports/ProjectListQueryGateway'
import type { ProjectNotificationGateway } from '../../ports/ProjectNotificationGateway'
import type { ProjectOperationJournalGateway } from '../../ports/ProjectOperationJournalGateway'
import type { ProjectRegistrationGateway } from '../../ports/ProjectRegistrationGateway'
import type { ProjectStorageGateway } from '../../ports/ProjectStorageGateway'
import type {
  ProjectListEntryVO,
  ProjectListPageVO,
  ProjectOperationVO,
  ProjectProgressListener,
  ProjectSaveLocationVO,
  ProjectSummaryVO,
  UnregisterProjectVO
} from '../../vo/ProjectVO'
import type { ProjectWorkspaceInspectionVO, ProjectWorkspaceVO } from '../../vo/ProjectWorkspaceVO'
import type { ProjectApplicationService } from '../ProjectApplicationService'
import type { ProjectCommitService } from '../ProjectCommitService'
import type { ProjectWorkspaceService } from '../ProjectWorkspaceService'
import { AppException } from '@common/errors/AppException'
import { ErrorCodes } from '@common/errors/ErrorCodes'
import type { LoggerGateway } from '@common/logging/LoggerGateway'
import { Project } from '@domain/projects/models/Project'
import type { ProjectIdentityRepository } from '@domain/projects/repositories/ProjectIdentityRepository'
import type { ProjectDomainService } from '@domain/projects/services/ProjectDomainService'

interface ProjectApplicationDependencies {
  readonly dialogs: ProjectFileDialogGateway
  readonly storage: ProjectStorageGateway
  readonly journal: ProjectOperationJournalGateway
  readonly execution: ProjectExecutionGateway
  readonly identities: ProjectIdentityRepository
  readonly domain: ProjectDomainService
  readonly commit: ProjectCommitService

  readonly nextId: () => string
  readonly notifications: ProjectNotificationGateway
  readonly listQuery: ProjectListQueryGateway
  readonly registration: ProjectRegistrationGateway
  readonly logger: LoggerGateway
  readonly workspace: ProjectWorkspaceService
}

export class ProjectApplicationServiceImpl implements ProjectApplicationService {
  /** 注入项目端口、领域规则、提交服务和身份生成能力。 */
  constructor(private readonly deps: ProjectApplicationDependencies) {}

  async chooseSaveLocation(): Promise<ProjectSaveLocationVO | null> {
    const location = await this.deps.dialogs.chooseSaveLocation()
    return toProjectSaveLocationVO(location)
  }

  clearSaveLocation(): void {
    this.deps.dialogs.clearSaveLocation()
  }

  /**
   * 新建所选目录中的项目，同请求重放沿用原操作。
   * @returns 完成结果，取消选择时返回取消状态。
   * @throws {AppException} 请求身份冲突、项目不合法或提交失败。
   */
  createProject(
    request: CreateProjectDTO,
    progress?: ProjectProgressListener
  ): Promise<ProjectOperationVO> {
    return this.deps.execution.executeProjectOperation(async () => {
      const fingerprint = createProjectFingerprint(request)
      const previous = await this.replay(request.operationId, fingerprint, progress)
      if (previous) return previous
      const project = Project.create({
        id: this.deps.nextId(),
        name: request.name,
        synopsis: request.synopsis
      })
      this.deps.notifications.publishProgress(
        { operationId: request.operationId, stage: 'selecting' },
        progress
      )
      const location = await this.deps.dialogs.takeSaveLocation()
      if (!location) return { status: 'cancelled' }
      const inspection = await this.deps.storage.inspect(location)
      const preparation = this.deps.domain.prepareCreation({ project, workspace: inspection })
      const operation: ProjectOperation = {
        operationId: request.operationId,
        fingerprint,
        kind: 'created',
        project: { id: project.id, name: project.name, synopsis: project.synopsis },
        location,
        initialize: preparation.requiresInitialization,
        stage: 'prepared'
      }
      await this.deps.journal.begin(operation)
      const result = await this.deps.commit.commit(operation, progress)
      this.deps.dialogs.clearSaveLocation()
      return result
    })
  }

  /**
   * 原位导入目录，无标识时初始化，同请求重放不再次选择目录。
   * @returns 完成结果，取消选择时返回取消状态。
   * @throws {AppException} 请求身份冲突、工程不合法或提交失败。
   */
  importProject(
    request: ImportProjectDTO,
    progress?: ProjectProgressListener
  ): Promise<ProjectOperationVO> {
    return this.deps.execution.executeProjectOperation(async () => {
      const fingerprint = importProjectFingerprint()
      const previous = await this.replay(request.operationId, fingerprint, progress)
      if (previous) return previous
      this.deps.notifications.publishProgress(
        { operationId: request.operationId, stage: 'selecting' },
        progress
      )
      const location = await this.deps.dialogs.selectDirectory()
      if (!location) return { status: 'cancelled' }
      this.deps.notifications.publishProgress(
        { operationId: request.operationId, stage: 'inspecting' },
        progress
      )
      const inspection = await this.deps.storage.inspect(location)
      const candidate =
        inspection.kind === 'existing'
          ? inspection.project
          : { id: this.deps.nextId(), name: '', synopsis: '' }
      const registeredIdentity = await this.deps.identities.findById(candidate.id)
      const preparation = this.deps.domain.prepareImport({
        candidate,
        registeredIdentity,
        workspace: inspection
      })
      const project = preparation.project
      const operation: ProjectOperation = {
        operationId: request.operationId,
        fingerprint,
        kind: 'imported',
        project: { id: project.id, name: project.name, synopsis: project.synopsis },
        location,
        initialize: preparation.requiresInitialization,
        stage: 'prepared'
      }
      await this.deps.journal.begin(operation)
      return this.deps.commit.commit(operation, progress)
    })
  }

  /**
   * 读取一页本机已登记项目，只检查本页工程。
   * @returns 包含可用或不可用条目的分页结果。
   * @throws {AppException} 登记文件整体读取失败。
   */
  async listProjects(request: ListProjectsDTO): Promise<ProjectListPageVO> {
    const [total, registrations] = await Promise.all([
      this.deps.listQuery.countRegistrations(),
      this.deps.listQuery.listRegistrations({ offset: request.offset, limit: request.limit })
    ])
    const entries = await Promise.all(
      registrations.map((registration) => this.readListEntry(registration))
    )
    return { entries, total, offset: request.offset, limit: request.limit }
  }

  /**
   * @throws {AppException} 项目未登记或工程不可用。
   */
  async openProject(request: OpenProjectDTO): Promise<ProjectSummaryVO> {
    const project = await this.loadRegisteredProject(request.id)
    return toProjectSummaryVO(project)
  }

  /**
   * @throws {AppException} 项目未登记、工程不可用或新名称不合法。
   */
  renameProject(request: RenameProjectDTO): Promise<ProjectSummaryVO> {
    return this.deps.execution.executeProjectOperation(async () => {
      const registration = await this.requireRegistration(request.id)
      const inspection = await this.deps.storage.inspect({ directory: registration.directory })
      const renamed = Project.restoreRegisteredProject({
        workspace: inspection,
        identity: { id: registration.id }
      }).rename({ name: request.name, synopsis: request.synopsis })
      const write = await this.deps.storage.saveProjectInfo(
        { directory: registration.directory },
        renamed
      )
      if (write === 'missing') {
        Project.restoreRegisteredProject({
          workspace: { kind: 'uninitialized', directoryName: '' },
          identity: { id: request.id }
        })
      }
      return toProjectSummaryVO(renamed)
    })
  }

  /**
   * 从本机列表移出登记，不删除工程文件。
   * @throws {AppException} 项目未登记或登记写入失败。
   */
  unregisterProject(request: UnregisterProjectDTO): Promise<UnregisterProjectVO> {
    return this.deps.execution.executeProjectOperation(async () => {
      const registration = await this.deps.listQuery.findRegistration(request.id)
      this.deps.domain.prepareUnregister(registration ? { id: registration.id } : null)
      const result = await this.deps.registration.removeRegistration(request.id)
      if (result === 'missing') this.deps.domain.prepareUnregister(null)
      return { id: request.id }
    })
  }

  /** 只核对已登记工程，不在查询路径隐式初始化。 */
  ensureProjectWorkspace(request: EnsureProjectWorkspaceDTO): Promise<ProjectWorkspaceVO> {
    return this.deps.execution.executeProjectOperation(async () => {
      await this.requireRegistration(request.projectId)
      return this.deps.workspace.ensureProjectWorkspace(request)
    })
  }

  /** 只读检查已登记工程，不在查询路径补建。 */
  inspectProjectWorkspace(
    request: EnsureProjectWorkspaceDTO
  ): Promise<ProjectWorkspaceInspectionVO> {
    return this.deps.execution.executeProjectOperation(async () => {
      await this.requireRegistration(request.projectId)
      return this.deps.workspace.inspectProjectWorkspace(request)
    })
  }

  private async requireRegistration(id: string): Promise<ProjectRegistrationRecord> {
    const registration = await this.deps.listQuery.findRegistration(id)
    this.deps.domain.requireRegistered(registration)
    return registration
  }

  private async loadRegisteredProject(id: string): Promise<Project> {
    const registration = await this.requireRegistration(id)
    const inspection = await this.deps.storage.inspect({ directory: registration.directory })
    return Project.restoreRegisteredProject({
      workspace: inspection,
      identity: { id: registration.id }
    })
  }

  /** 已识别的单项失败转为不可用列表项，未知失败继续传播。 */
  private async readListEntry(
    registration: ProjectRegistrationRecord
  ): Promise<ProjectListEntryVO> {
    try {
      const inspection = await this.deps.storage.inspect({ directory: registration.directory })
      const project = Project.restoreRegisteredProject({
        workspace: inspection,
        identity: { id: registration.id }
      })
      return { status: 'available', ...toProjectSummaryVO(project) }
    } catch (error) {
      if (!(error instanceof AppException)) throw error
      this.deps.logger.warn('项目列表项不可用', {
        projectId: registration.id,
        errorCode: error.code
      })
      return {
        status: 'unavailable',
        id: registration.id,
        code: error.code,
        msg: error.message
      }
    }
  }

  /** 幂等重放同一操作：续提交流程，请求内容不一致时拒绝。 */
  private async replay(
    operationId: string,
    fingerprint: string,
    progress?: ProjectProgressListener
  ): Promise<ProjectOperationVO | null> {
    const operation = await this.deps.journal.find(operationId)
    if (!operation) return null
    if (operation.fingerprint !== fingerprint)
      throw new AppException({
        code: ErrorCodes.operationConflict,
        msg: '同一操作标识对应的请求内容不一致'
      })
    if (operation.stage === 'completed') return toProjectOperationVO(operation)
    return this.deps.commit.commit(operation, progress)
  }
}
