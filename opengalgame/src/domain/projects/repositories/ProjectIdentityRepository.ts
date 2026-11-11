import type { RegisteredProjectIdentity } from '../models/ProjectWorkspace'

export interface ProjectIdentityRepository {
  /**
   * @returns 未登记时为 null。
   */
  findById(projectId: string): Promise<RegisteredProjectIdentity | null>
}
