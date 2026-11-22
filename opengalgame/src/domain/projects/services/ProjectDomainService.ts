import type { ProjectUnregisteredEvent } from '../events/ProjectUnregisteredEvent'
import type { ProjectRegistrationResult } from '../models/ProjectRegistrationResult'
import type {
  ProjectCreationRequest,
  ProjectImportRequest,
  ProjectPreparationResult,
  ProjectRecoveryRequest,
  RegisteredProjectIdentity
} from '../models/ProjectWorkspace'

export interface ProjectDomainService {
  validateRegistration(result: ProjectRegistrationResult): void
  prepareCreation(request: ProjectCreationRequest): ProjectPreparationResult
  prepareImport(request: ProjectImportRequest): ProjectPreparationResult
  validateRecovery(request: ProjectRecoveryRequest): void
  requireRegistered(
    registeredIdentity: RegisteredProjectIdentity | null
  ): asserts registeredIdentity is RegisteredProjectIdentity
  prepareUnregister(registeredIdentity: RegisteredProjectIdentity | null): ProjectUnregisteredEvent
}
