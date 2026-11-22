import type { RegisteredProjectIdentity } from '../models/ProjectWorkspace'

export interface ProjectIdentityRepository {
  findById(projectId: string): Promise<RegisteredProjectIdentity | null>
}
