import type { VersionContentSource, VersionSaveMode } from '../dto/ProjectVersioningDTO'
import type { VersionTarget } from '../models/VersionTarget'

/**
 * 用户历史投影和清理标记。
 * 投影可以重建；清理标记是独立决定，不能被重建覆盖。
 */
export interface VersionHistoryGateway {
  /**
   * 读取当前投影。
   * complete 为 false 时，条目不能当作完整历史，也不能把空条目当成成功的空列表。
   * @throws {AppException} 投影无法读取。
   */
  readProjection(projectId: string): Promise<VersionHistoryProjection>

  /**
   * 替换一个工程的可见投影。
   * 不得删除清理标记，也不得改写作品或事务证据。
   * @throws {AppException} 投影无法写入。
   */
  writeProjection(projectId: string, entries: readonly VersionHistoryFact[]): Promise<void>

  /**
   * 标记投影滞后。
   * 失败时调用方不能把旧的完整投影继续当成已经包含最新结算。
   */
  markIncomplete(projectId: string): Promise<void>

  /** 读取已经持久化的清理决定。 */
  readClearMarkers(projectId: string): Promise<readonly VersionClearMarker[]>

  /**
   * 先持久化清理决定。重复标记同一条目保持幂等。
   * 失败时调用方不得报告已经清理。
   * @throws {AppException} 标记不能持久化。
   */
  persistClearMarkers(projectId: string, historyIds: readonly string[]): Promise<void>

  /**
   * 把本工程未清理的历史身份解析为原操作。
   * 已清理或不存在返回 null。投影不完整时必须抛出，不能返回 null。
   * @throws {AppException} 历史关联无法读取，或投影已知不完整。
   */
  resolveActive(projectId: string, historyId: string): Promise<VersionHistoryBinding | null>
}

/** 重建历史所需的事实。操作身份只供后端继续编排，不进入用户结果。 */
export type VersionHistoryFact = {
  readonly historyId: string
  readonly projectId: string
  readonly operationId: string
  readonly sourceModule: string
  readonly targets: readonly VersionTarget[]
  readonly saveMode: VersionSaveMode
  readonly contentSource: VersionContentSource
  readonly title: string
  readonly summary: string
  readonly createdAt: string
  readonly state: '已提交' | '已回退'
  readonly canUndo: boolean
  readonly canClear: boolean
}

/** 可重建的列表投影。 */
export type VersionHistoryProjection = {
  readonly complete: boolean
  readonly entries: readonly VersionHistoryFact[]
}

/** 已确认的用户清理或系统超额清理。 */
export type VersionClearMarker = {
  readonly projectId: string
  readonly historyId: string
}

/** 未清理历史条目对应的原操作。 */
export type VersionHistoryBinding = {
  readonly operationId: string
}
