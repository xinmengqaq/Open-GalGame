import { readProjectRegistrations } from './projectRegistrations'
import type { RegisteredProjectIdentity } from '@domain/projects/models/ProjectWorkspace'
import type { ProjectIdentityRepository } from '@domain/projects/repositories/ProjectIdentityRepository'

export class LocalProjectIdentityRepositoryImpl implements ProjectIdentityRepository {
  constructor(private readonly userDirectory: string) {}

  async findById(projectId: string): Promise<RegisteredProjectIdentity | null> {
    const registrations = await readProjectRegistrations(this.userDirectory)
    const registration = registrations.find((item) => item.id === projectId)
    return registration ? { id: registration.id } : null
  }
}
