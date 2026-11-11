import type { ProjectNotificationGateway } from '@application/projects/ports/ProjectNotificationGateway'
import type { ProjectProgressVO, ProjectProgressListener } from '@application/projects/vo/ProjectVO'
import type { LoggerGateway } from '@common/logging/LoggerGateway'

export class LocalProjectNotificationGatewayImpl implements ProjectNotificationGateway {
  constructor(private readonly logger: LoggerGateway) {}
  /** 隔离观察者故障，通知不改变提交结果。 */
  publishProgress(progress: ProjectProgressVO, listener?: ProjectProgressListener): void {
    try {
      listener?.(progress)
    } catch {
      this.logger.warn('项目通知未送达，持久化结果保持有效', { operationId: progress.operationId })
    }
  }
}
