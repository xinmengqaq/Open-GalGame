import type { VersionContentSource, VersionSaveMode } from '../dto/ProjectVersioningDTO'
import type { VersionTarget } from '../dto/VersionTarget'
import type { VersionBoundRetention } from './VersionContentGateway'

export interface VersionOperationRecordGateway {
  bindPrepared(record: VersionPreparedRecord): Promise<void>

  read(projectId: string, operationId: string): Promise<VersionOperationRecord | null>

  bindCommitIntent(
    projectId: string,
    operationId: string,
    intent: VersionCommitIntent
  ): Promise<void>

  listByProject(projectId: string): Promise<readonly VersionOperationRecord[]>

  replaceRetentions(
    projectId: string,
    operationId: string,
    retentions: readonly VersionBoundRetention[]
  ): Promise<void>

  prepareOrClaimCaller(
    record: VersionPreparedRecord,
    callerOperationId: string
  ): Promise<VersionOperationRecord>

  bindCallerOperation(binding: VersionCallerOperationBinding): Promise<void>

  readCallerOperation(
    projectId: string,
    sourceModule: string,
    callerOperationId: string
  ): Promise<VersionCallerOperationLink | null>

  findCallerOperation(
    sourceModule: string,
    callerOperationId: string
  ): Promise<VersionCallerOperationLink | null>

}

export type VersionCallerOperationState =
  | 'pending'
  | 'notStarted'
  | 'committed'
  | 'notCommitted'

export type VersionPreparedRecord = {
  readonly projectId: string
  readonly operationId: string
  readonly sourceModule: string
  readonly targets: readonly VersionTarget[]
  readonly changePaths: readonly string[]
  readonly watchedPaths: readonly string[]
  readonly baselineRef: string
  readonly revisionRef: string
}

export type VersionCommitIntent = {
  readonly contentFingerprint: string
  readonly historyId: string
  readonly saveMode: VersionSaveMode
  readonly contentSource: VersionContentSource
  readonly title: string
  readonly summary: string
  readonly retentions: readonly VersionBoundRetention[]
}

export type VersionOperationRecord = VersionPreparedRecord & {
  readonly commitIntent: VersionCommitIntent | null
  readonly callerOperationId?: string
}

export type VersionCallerOperationBinding = {
  readonly projectId: string
  readonly sourceModule: string
  readonly callerOperationId: string
  readonly operationId: string
  readonly targets: readonly VersionTarget[]
  readonly changePaths: readonly string[]
  readonly watchedPaths: readonly string[]
}

export type VersionCallerOperationLink = {
  readonly projectId: string
  readonly sourceModule: string
  readonly callerOperationId: string
  readonly operationId: string
  readonly state: VersionCallerOperationState
}
