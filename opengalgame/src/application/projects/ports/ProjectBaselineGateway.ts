/**
 * 把工程相对路径纳入作品基线。
 * 没有基线时建立首个基线；已有基线时只补其中尚不存在的路径。
 */
export interface ProjectBaselineGateway {
  /**
   * @throws {AppException} 工程不可用、路径不合法或基线不能建立。
   */
  ensureDeclaredPaths(projectId: string, paths: readonly string[]): Promise<void>

  /**
   * 只读确认作品仓库、HEAD，以及声明路径已在基线中。
   * 不创建仓库，不提交。缺失或无法读取时返回 false。
   */
  inspectDeclaredPaths(projectId: string, paths: readonly string[]): Promise<boolean>
}
