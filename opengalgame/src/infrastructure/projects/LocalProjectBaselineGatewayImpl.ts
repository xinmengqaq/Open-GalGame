import type { ProjectBaselineGateway } from '@application/projects/ports/ProjectBaselineGateway'
import type { VersionTransactionGateway } from '@application/project-versioning/ports/VersionTransactionGateway'

export class LocalProjectBaselineGatewayImpl implements ProjectBaselineGateway {
  constructor(private readonly transactions: VersionTransactionGateway) {}

  ensureDeclaredPaths(projectId: string, paths: readonly string[]): Promise<void> {
    return this.transactions
      .ensureDeclaredPaths({ projectId, paths: [...paths] })
      .then(() => undefined)
  }

  inspectDeclaredPaths(projectId: string, paths: readonly string[]): Promise<boolean> {
    return this.transactions.inspectDeclaredPaths({ projectId, paths: [...paths] })
  }
}
