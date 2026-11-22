export interface ProjectBaselineGateway {
  ensureDeclaredPaths(projectId: string, paths: readonly string[]): Promise<void>

  inspectDeclaredPaths(projectId: string, paths: readonly string[]): Promise<boolean>
}
