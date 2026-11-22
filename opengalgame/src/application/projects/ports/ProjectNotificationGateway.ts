import type { ProjectProgressVO, ProjectProgressListener } from '../vo/ProjectVO'

export interface ProjectNotificationGateway {
  publishProgress(progress: ProjectProgressVO, listener?: ProjectProgressListener): void
}
