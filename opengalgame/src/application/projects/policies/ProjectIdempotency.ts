import type { CreateProjectDTO } from '../dto/ProjectDTO'

export function createProjectFingerprint(request: CreateProjectDTO): string {
  return JSON.stringify({ kind: 'create', name: request.name, synopsis: request.synopsis ?? '' })
}

export function importProjectFingerprint(): string {
  return JSON.stringify({ kind: 'import' })
}
