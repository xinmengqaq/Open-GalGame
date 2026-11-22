import type { ProjectOperation } from '../models/ProjectOperation'
import type { ProjectProgressListener, ProjectOperationVO } from '../vo/ProjectVO'

export interface ProjectCommitService {
  commit(
    operation: ProjectOperation,
    progress?: ProjectProgressListener
  ): Promise<ProjectOperationVO>
}
