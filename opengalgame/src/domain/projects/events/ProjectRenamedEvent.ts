export class ProjectRenamedEvent {
  readonly kind = 'renamed'
  readonly projectId: string
  readonly name: string

  /**
   * 项目名称或简介已合法变更，尚未保存。
   * @param projectId - 保持不变的项目标识。
   */
  constructor({ projectId, name }: { projectId: string; name: string }) {
    this.projectId = projectId
    this.name = name
  }
}
