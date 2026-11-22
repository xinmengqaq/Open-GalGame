import type { ProjectFileOperationSettlement } from '../vo/ProjectFileOperationVO'

export type { ProjectFileOperationSettlement }
import type { PreparedProjectFileChange } from './ProjectFileOperationGateway'
import type { VerifiedProjectReadLocation } from '../models/ProjectInputSourceReadFacts'

export interface ProjectWorkVersionGateway {
  publish(request: {
    project: VerifiedProjectReadLocation
    operationId: string
    changes: readonly PreparedProjectFileChange[]
    watchedPaths?: readonly string[]
    expectedCatalogVersion: string
  }): Promise<void>

  readOperation(
    project: VerifiedProjectReadLocation,
    operationId: string
  ): Promise<ProjectFileOperationSettlement>

  hasOperationLink(project: VerifiedProjectReadLocation, operationId: string): Promise<boolean>

  resolveCallerOperations(
    project: VerifiedProjectReadLocation,
    operationIds: readonly string[]
  ): Promise<readonly { callerOperationId: string; state: 'pending' | 'notStarted' | 'committed' | 'notCommitted' }[]>

  recoverProject(project: VerifiedProjectReadLocation): Promise<void>
}
