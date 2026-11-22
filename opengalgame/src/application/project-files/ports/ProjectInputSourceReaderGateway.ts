import type {
  ProjectFolderDeletionReadFact,
  ProjectInputCatalogReadFact
} from '../models/ProjectInputCatalogReadFacts'
import type {
  ProjectInputSourceInspectionFact,
  ProjectInputSourcesReadFact,
  ProjectInputSourceSummary,
  VerifiedProjectReadLocation
} from '../models/ProjectInputSourceReadFacts'

export interface ProjectInputSourceReaderGateway {
  scanProjectInputSources(
    project: VerifiedProjectReadLocation
  ): Promise<readonly ProjectInputSourceSummary[]>

  inspectProjectInputSources(
    project: VerifiedProjectReadLocation
  ): Promise<ProjectInputSourceInspectionFact>

  readProjectInputSources(
    project: VerifiedProjectReadLocation,
    sourceIds: readonly string[]
  ): Promise<ProjectInputSourcesReadFact>

  readProjectInputCatalog(
    project: VerifiedProjectReadLocation
  ): Promise<ProjectInputCatalogReadFact>

  readFolderDeletionPlan(
    project: VerifiedProjectReadLocation,
    folderId: string
  ): Promise<ProjectFolderDeletionReadFact>
}
