import type { ProjectOperation } from '../models/ProjectOperation'
import type { ProjectRegistrationResult } from '@domain/projects/models/ProjectRegistrationResult'

export interface ProjectRegistrationGateway {
  registerProject(operation: ProjectOperation): Promise<ProjectRegistrationResult>

  removeRegistration(id: string): Promise<'removed' | 'missing'>
}
