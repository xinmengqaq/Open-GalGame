export class ProjectImportedEvent {
  readonly kind = 'imported'
  readonly projectId: string
  readonly name: string

  constructor({ projectId, name }: { projectId: string; name: string }) {
    this.projectId = projectId
    this.name = name
  }
}
