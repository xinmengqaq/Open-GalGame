export class ProjectCreatedEvent {
  readonly kind = 'created'
  readonly projectId: string
  readonly name: string

  /** 项目已合法建立，尚未保存。 */
  constructor({ projectId, name }: { projectId: string; name: string }) {
    this.projectId = projectId
    this.name = name
  }
}
