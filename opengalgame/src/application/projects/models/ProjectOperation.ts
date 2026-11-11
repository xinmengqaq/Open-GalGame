import type { ProjectLocation } from './ProjectLocation'
import type { ProjectInfo } from '@domain/projects/models/ProjectWorkspace'

export interface ProjectOperation {
  operationId: string
  fingerprint: string
  kind: 'created' | 'imported'
  project: Required<ProjectInfo>
  location: ProjectLocation
  initialize: boolean
  stage: 'prepared' | 'published' | 'completed'
}
