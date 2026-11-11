import type { Project } from './Project'

export interface ProjectInfo {
  id: string
  name: string
  synopsis?: string
}

export interface RegisteredProjectIdentity {
  id: string
}

export type WorkspaceInspection =
  { kind: 'uninitialized'; directoryName: string } | { kind: 'existing'; project: ProjectInfo }

export interface ProjectCreationRequest {
  project: Project
  workspace: WorkspaceInspection
}

export interface ProjectImportRequest {
  candidate: ProjectInfo
  registeredIdentity: RegisteredProjectIdentity | null
  workspace: WorkspaceInspection
}

export interface ProjectRecoveryRequest {
  expectedProject: ProjectInfo
  workspace: WorkspaceInspection
}

export interface ProjectPreparationResult {
  project: Project
  requiresInitialization: boolean
}
