import type { ProjectOperation } from '../models/ProjectOperation'

export interface ProjectOperationJournalGateway {
  /**
   * @returns 未记录时为 null。
   */
  find(operationId: string): Promise<ProjectOperation | null>

  /** 记录尚未写入工作区的操作。 */
  begin(operation: ProjectOperation): Promise<void>

  markPublished(operationId: string): Promise<void>

  complete(operationId: string): Promise<void>

  remove(operationId: string): Promise<void>

  /** 列出待恢复操作标识，逐条读取以隔离损坏记录。 */
  listIncomplete(): Promise<string[]>
}
