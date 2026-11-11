export class ProjectUnregisteredEvent {
  readonly kind = 'unregistered'
  readonly projectId: string

  /** 本机登记将被移除，工程文件仍保留。 */
  constructor({ projectId }: { projectId: string }) {
    this.projectId = projectId
  }
}
