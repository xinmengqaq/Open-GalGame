import type { ProjectOperation } from '../models/ProjectOperation'

export interface ProjectOperationJournalGateway {
  find(operationId: string): Promise<ProjectOperation | null>

  begin(operation: ProjectOperation): Promise<void>

  markPublished(operationId: string): Promise<void>

  complete(operationId: string): Promise<void>

  remove(operationId: string): Promise<void>

  listIncomplete(): Promise<string[]>
}
