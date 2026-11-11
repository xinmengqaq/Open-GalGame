import { readProjectRegistrations, writeProjectRegistrations } from './projectRegistrations'
import type { ProjectOperation } from '@application/projects/models/ProjectOperation'
import type { ProjectRegistrationGateway } from '@application/projects/ports/ProjectRegistrationGateway'
import type { ProjectRegistrationResult } from '@domain/projects/models/ProjectRegistrationResult'

export class LocalProjectRegistrationGatewayImpl implements ProjectRegistrationGateway {
  constructor(private readonly userDirectory: string) {}

  /** 只登记已发布身份，同一操作幂等。 */
  async registerProject(operation: ProjectOperation): Promise<ProjectRegistrationResult> {
    const registrations = await readProjectRegistrations(this.userDirectory)
    const { id } = operation.project
    const { directory } = operation.location
    const matches = registrations.filter(
      (item) =>
        item.id === id || item.directory === directory || item.operationId === operation.operationId
    )
    if (matches.length > 0) {
      const [match] = matches
      return matches.length === 1 &&
        match.id === id &&
        match.directory === directory &&
        match.operationId === operation.operationId
        ? { status: 'alreadyRegistered' }
        : { status: 'conflict' }
    }
    await writeProjectRegistrations(this.userDirectory, [
      ...registrations,
      { id, directory, operationId: operation.operationId }
    ])
    return { status: 'registered' }
  }

  /** 只删除登记项，不删除工程目录。 */
  async removeRegistration(id: string): Promise<'removed' | 'missing'> {
    const registrations = await readProjectRegistrations(this.userDirectory)
    const remaining = registrations.filter((item) => item.id !== id)
    if (remaining.length === registrations.length) return 'missing'
    await writeProjectRegistrations(this.userDirectory, remaining)
    return 'removed'
  }
}
