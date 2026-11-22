export interface ProjectSceneIdentity {
  readonly sceneId: string
  readonly canvasId: string
}

export interface ProjectSceneIdentityGateway {
  ensureIdentity(projectId: string): Promise<ProjectSceneIdentity>

  readIdentity(projectId: string): Promise<ProjectSceneIdentity | null>
}
