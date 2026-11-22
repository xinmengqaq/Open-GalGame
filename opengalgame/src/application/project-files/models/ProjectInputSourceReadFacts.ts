import type { ProjectLocation } from '../../projects/models/ProjectLocation'
import type { ProjectInputSourceFact } from '@domain/project-files/models/ProjectFileDiagnostic'
import type {
  ProjectInputSource,
  ProjectInputSourceSummary
} from '@domain/project-files/models/ProjectInputSource'

export type VerifiedProjectReadLocation = {
  projectId: string
  location: ProjectLocation
}

export type ProjectInputSourceInspectionFact = {
  projectId: string
  inputSourceFormatSupported: boolean
  sources: readonly ProjectInputSourceFact[]
  catalogDamaged: boolean
}

export type ProjectInputSourcesReadFact = {
  projectId: string
  readVersion: string
  sources: readonly ProjectInputSource[]
}

export type { ProjectInputSourceSummary }
