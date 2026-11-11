import type { ProjectExecutionGateway } from '../../ports/ProjectExecutionGateway'
import type { ProjectOperationJournalGateway } from '../../ports/ProjectOperationJournalGateway'
import type { ProjectCommitService } from '../ProjectCommitService'
import type { ProjectRecoveryApplicationService } from '../ProjectRecoveryApplicationService'
import type { LoggerGateway } from '@common/logging/LoggerGateway'

interface ProjectRecoveryDependencies {
  readonly journal: ProjectOperationJournalGateway
  readonly execution: ProjectExecutionGateway
  readonly commit: ProjectCommitService
  readonly logger: LoggerGateway
}

export class ProjectRecoveryApplicationServiceImpl implements ProjectRecoveryApplicationService {
  constructor(private readonly deps: ProjectRecoveryDependencies) {}

  /**
   * 在后台任务边界逐项恢复，单项失败不阻断后续操作。
   * @returns 本次未能恢复的操作数量。
   */
  recoverIncompleteOperations(): Promise<number> {
    return this.deps.execution.executeProjectOperation(async () => {
      let failures = 0
      for (const operationId of await this.deps.journal.listIncomplete()) {
        try {
          const operation = await this.deps.journal.find(operationId)
          if (operation) await this.deps.commit.commit(operation)
        } catch {
          failures++
          this.deps.logger.error('项目启动恢复未完成', { operationId })
        }
      }
      return failures
    })
  }
}
