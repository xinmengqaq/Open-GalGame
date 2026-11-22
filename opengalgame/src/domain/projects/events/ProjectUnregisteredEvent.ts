export class ProjectUnregisteredEvent {
  readonly kind = 'unregistered'
  readonly projectId: string

  constructor({ projectId }: { projectId: string }) {
    this.projectId = projectId
  }
}
