export interface ProjectSceneSeedGateway {
  ensureSceneFiles(projectId: string, sceneId: string): Promise<void>

  inspectSceneFiles(projectId: string, sceneId: string): Promise<boolean>
}
