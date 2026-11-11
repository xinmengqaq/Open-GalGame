export class ProjectImportedEvent {
  readonly kind = 'imported'
  readonly projectId: string
  readonly name: string

  /**
   * 目录中的项目身份已被接纳，尚未登记。
   * @param projectId - 保留的原项目标识。
   */
  constructor({ projectId, name }: { projectId: string; name: string }) {
    this.projectId = projectId
    this.name = name
  }
}
