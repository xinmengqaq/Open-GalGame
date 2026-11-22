import type { ProjectLocation } from '../models/ProjectLocation'
import type { ProjectOperation } from '../models/ProjectOperation'
import type { Project } from '@domain/projects/models/Project'
import type { WorkspaceInspection } from '@domain/projects/models/ProjectWorkspace'

export interface ProjectStorageGateway {
  inspect(location: ProjectLocation): Promise<WorkspaceInspection>

  initialize(operation: ProjectOperation): Promise<void>

  isPublished(operation: ProjectOperation): Promise<boolean>

  discard(operation: ProjectOperation): Promise<void>

  saveProjectInfo(location: ProjectLocation, project: Project): Promise<'saved' | 'missing'>
}
