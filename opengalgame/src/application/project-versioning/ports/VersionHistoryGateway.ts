import type { VersionContentSource, VersionSaveMode } from '../dto/ProjectVersioningDTO'
import type { VersionTarget } from '../dto/VersionTarget'

export interface VersionHistoryGateway {
  readProjection(projectId: string): Promise<VersionHistoryProjection>

  writeProjection(projectId: string, entries: readonly VersionHistoryFact[]): Promise<void>

  markIncomplete(projectId: string): Promise<void>

  readClearMarkers(projectId: string): Promise<readonly VersionClearMarker[]>

  persistClearMarkers(projectId: string, historyIds: readonly string[]): Promise<void>

  resolveActive(projectId: string, historyId: string): Promise<VersionHistoryBinding | null>
}

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

export type VersionHistoryProjection = {
  readonly complete: boolean
  readonly entries: readonly VersionHistoryFact[]
}

export type VersionClearMarker = {
  readonly projectId: string
  readonly historyId: string
}

export type VersionHistoryBinding = {
  readonly operationId: string
}
