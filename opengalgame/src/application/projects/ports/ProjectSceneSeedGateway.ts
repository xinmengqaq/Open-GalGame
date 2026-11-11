/**
 * 只补缺失的默认场景脚本和场景锁。
 * 已有脚本、已有锁状态和未知字段都保留；损坏的锁不重写。
 */
export interface ProjectSceneSeedGateway {
  /**
   * @throws {AppException} 路径不安全、锁损坏或文件不能写入。
   */
  ensureSceneFiles(projectId: string, sceneId: string): Promise<void>

  /**
   * 只读确认默认场景脚本和锁。不创建、不改写。
   * 缺失、损坏或不包含该场景时返回 false。
   */
  inspectSceneFiles(projectId: string, sceneId: string): Promise<boolean>
}
