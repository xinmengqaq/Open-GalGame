import type { ProjectProgressVO, ProjectProgressListener } from '../vo/ProjectVO'

export interface ProjectNotificationGateway {
  /** 发布安全通知，隔离接收端故障。 */
  publishProgress(progress: ProjectProgressVO, listener?: ProjectProgressListener): void
}
