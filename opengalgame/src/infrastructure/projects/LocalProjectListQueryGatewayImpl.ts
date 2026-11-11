import { readProjectRegistrations } from './projectRegistrations'
import type {
  ProjectListQueryGateway,
  ProjectRegistrationPageQuery,
  ProjectRegistrationRecord
} from '@application/projects/ports/ProjectListQueryGateway'

function compareRegistrationIds(
  left: ProjectRegistrationRecord,
  right: ProjectRegistrationRecord
): number {
  if (left.id === right.id) return 0
  return left.id < right.id ? -1 : 1
}

export class LocalProjectListQueryGatewayImpl implements ProjectListQueryGateway {
  constructor(private readonly userDirectory: string) {}

  async listRegistrations(
    query: ProjectRegistrationPageQuery
  ): Promise<ProjectRegistrationRecord[]> {
    const registrations = (await readProjectRegistrations(this.userDirectory)).map(
      ({ id, directory }) => ({ id, directory })
    )
    return registrations
      .sort(compareRegistrationIds)
      .slice(query.offset, query.offset + query.limit)
  }

  async countRegistrations(): Promise<number> {
    return (await readProjectRegistrations(this.userDirectory)).length
  }

  async findRegistration(id: string): Promise<ProjectRegistrationRecord | null> {
    const registrations = await readProjectRegistrations(this.userDirectory)
    const registration = registrations.find((item) => item.id === id)
    return registration ? { id: registration.id, directory: registration.directory } : null
  }
}
