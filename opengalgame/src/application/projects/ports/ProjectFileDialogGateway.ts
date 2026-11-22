import type { ProjectLocation } from '../models/ProjectLocation'

export interface ProjectFileDialogGateway {
  selectDirectory(): Promise<ProjectLocation | null>

  chooseSaveLocation(): Promise<ProjectLocation | null>

  takeSaveLocation(): Promise<ProjectLocation | null>

  clearSaveLocation(): void
}
