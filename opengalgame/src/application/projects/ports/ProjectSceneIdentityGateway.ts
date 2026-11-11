/** 工程内已持久化的默认场景身份。 */
export interface ProjectSceneIdentity {
  readonly sceneId: string
  readonly canvasId: string
}

/**
 * 读取或补齐工程元数据中的默认场景身份。
 * 已有身份原样返回，不改写名称、简介或其他字段。
 */
export interface ProjectSceneIdentityGateway {
  /**
   * @throws {AppException} 工程不可用、元数据损坏或身份不能安全写入。
   */
  ensureIdentity(projectId: string): Promise<ProjectSceneIdentity>

  /**
   * 只读读取已持久化身份。不补写。
   * 身份字段都还没有时返回 null。文件缺失或身份损坏时抛出，消息不含路径。
   */
  readIdentity(projectId: string): Promise<ProjectSceneIdentity | null>
}
