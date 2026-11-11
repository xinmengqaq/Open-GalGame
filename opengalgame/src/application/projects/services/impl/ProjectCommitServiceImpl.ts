import { toProjectOperationVO } from '../../mapping/ProjectViewMapper'
import type { ProjectOperation } from '../../models/ProjectOperation'
import type { ProjectNotificationGateway } from '../../ports/ProjectNotificationGateway'
import type { ProjectOperationJournalGateway } from '../../ports/ProjectOperationJournalGateway'
import type { ProjectRegistrationGateway } from '../../ports/ProjectRegistrationGateway'
import type { ProjectStorageGateway } from '../../ports/ProjectStorageGateway'
import type { ProjectOperationVO, ProjectProgressListener } from '../../vo/ProjectVO'
import type { ProjectWorkspaceService } from '../ProjectWorkspaceService'
import type { ProjectCommitService } from '../ProjectCommitService'
import { AppException } from '@common/errors/AppException'
import { ErrorCodes } from '@common/errors/ErrorCodes'
import type { LoggerGateway } from '@common/logging/LoggerGateway'
import { ProjectErrorCodes } from '@domain/projects/errors/ProjectErrorCodes'
import type { ProjectDomainService } from '@domain/projects/services/ProjectDomainService'

interface ProjectCommitDependencies {
  readonly domain: ProjectDomainService
  readonly storage: ProjectStorageGateway
  readonly registration: ProjectRegistrationGateway
  readonly journal: ProjectOperationJournalGateway
  readonly logger: LoggerGateway
  readonly notifications: ProjectNotificationGateway
  readonly workspace: ProjectWorkspaceService
}

export class ProjectCommitServiceImpl implements ProjectCommitService {
  constructor(private readonly deps: ProjectCommitDependencies) {}

  /**
   * 协调持久提交与必要补偿。
   * 失败时先核对持久发布事实，已发布工程保留恢复记录。
   * @throws {AppException} 发布、登记或清理失败，补偿失败保留全部原因。
   */
  async commit(
    operation: ProjectOperation,
    progress?: ProjectProgressListener
  ): Promise<ProjectOperationVO> {
    const { storage, journal, registration, logger } = this.deps
    let workspacePublished = !operation.initialize
    let registrationPhaseStarted = false
    try {
      if (operation.initialize) {
        workspacePublished = await storage.isPublished(operation)
        if (!workspacePublished) {
          this.deps.notifications.publishProgress(
            { operationId: operation.operationId, stage: 'initializing' },
            progress
          )
          await storage.initialize(operation)
          workspacePublished = true
        }
      } else {
        const current = await storage.inspect(operation.location)
        this.deps.domain.validateRecovery({
          expectedProject: operation.project,
          workspace: current
        })
      }
      registrationPhaseStarted = true
      await journal.markPublished(operation.operationId)
      this.deps.notifications.publishProgress(
        { operationId: operation.operationId, stage: 'registering' },
        progress
      )
      this.deps.domain.validateRegistration(await registration.registerProject(operation))
      await this.deps.workspace.ensureProjectWorkspace({ projectId: operation.project.id })
      await journal.complete(operation.operationId)
    } catch (error) {
      if (!workspacePublished) {
        try {
          workspacePublished = await storage.isPublished(operation)
          if (!workspacePublished) {
            await storage.discard(operation)
            await journal.remove(operation.operationId)
          }
        } catch (cleanupError) {
          logger.warn('项目暂存清理未完成，已保留恢复记录', { operationId: operation.operationId })
          throw new AppException({
            code: error instanceof AppException ? error.code : ErrorCodes.internalError,
            msg: error instanceof AppException ? error.message : '项目提交失败，暂存清理也未完成',
            cause: new AggregateError([error, cleanupError], '项目提交与清理失败')
          })
        }
      }
      const preserved =
        error instanceof AppException &&
        (error.code === ProjectErrorCodes.alreadyRegistered ||
          error.code === ProjectErrorCodes.workspaceNotReady)
      if (workspacePublished && registrationPhaseStarted && !preserved) {
        throw new AppException({
          code: ProjectErrorCodes.registrationFailed,
          msg: '工程已保存，但项目登记未完成，请重试原操作',
          cause: error
        })
      }
      throw error
    }
    this.deps.notifications.publishProgress(
      {
        operationId: operation.operationId,
        stage: 'completed',
        projectId: operation.project.id,
        event: operation.kind
      },
      progress
    )
    return toProjectOperationVO(operation)
  }
}
