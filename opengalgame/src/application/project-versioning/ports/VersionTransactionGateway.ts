import type { VersionCallerOperationState } from './VersionOperationRecordGateway'

export interface VersionTransactionGateway {
  initializeBaseline(input: InitializeBaselineRequest): Promise<VersionBaselineFact>

  ensureDeclaredPaths(input: EnsureDeclaredPathsRequest): Promise<VersionBaselineFact>

  readBaseline(projectId: string): Promise<VersionBaselineFact | null>

  inspectDeclaredPaths(input: EnsureDeclaredPathsRequest): Promise<boolean>

  readTransaction(projectId: string, operationId: string): Promise<VersionTransactionView | null>

  commit(input: VersionCommitRequest): Promise<VersionCommitExecution>

  rollback(input: VersionRollbackRequest): Promise<VersionRollbackExecution>

  recoverProject(projectId: string, sourceModule: string): Promise<void>

  resolveCallerOperations(
    projectId: string,
    sourceModule: string,
    callerOperationIds: readonly string[]
  ): Promise<readonly { callerOperationId: string; state: VersionCallerOperationState }[]>
}

export type VersionBaselineFact = {
  readonly baselineRef: string
  readonly revisionRef: string
}

export type VersionTransactionView = {
  readonly operationId: string
  readonly contentFingerprint: string
  readonly outcome: VersionTransactionOutcome
}

export type VersionTransactionOutcome =
  | {
      readonly state: '已提交'
      readonly revisionRef: string
      readonly changedAt: string
    }
  | {
      readonly state: '无变更'
      readonly revisionRef: string
      readonly changedAt: string
    }
  | { readonly state: '未提交' }
  | {
      readonly state: '待回退'
      readonly revisionRef: string
      readonly changedAt: string
    }
  | {
      readonly state: '已回退'
      readonly originalRevisionRef: string
      readonly revisionRef: string
      readonly changedAt: string
    }
  | { readonly state: '待核对' }

export type VersionCommitObservation = {
  readonly baseline: VersionBaselineFact
  readonly subsequentPaths: readonly string[]
  readonly transaction: VersionTransactionView | null
}

export type VersionRollbackObservation = {
  readonly subsequentPaths: readonly string[]
  readonly transaction: VersionTransactionView | null
}

export type VersionBoundaryDecision = { readonly action: 'publish' } | { readonly action: 'reuse' }

export type VersionLimitedChange = {
  readonly relativePath: string
  readonly action: 'add' | 'modify' | 'delete'
  readonly retentionRef: string | null
}

export type InitializeBaselineRequest = {
  readonly projectId: string
  readonly initialPaths: readonly string[]
}

export type EnsureDeclaredPathsRequest = {
  readonly projectId: string
  readonly paths: readonly string[]
}

export type VersionCommitRequest = {
  readonly projectId: string
  readonly operationId: string
  readonly callerOperationId?: string
  readonly sourceModule: string
  readonly baselineRef: string
  readonly contentFingerprint: string
  readonly changes: readonly VersionLimitedChange[]
  readonly scopeBaseline?: VersionScopeBaseline
  readonly verify: (observation: VersionCommitObservation) => Promise<VersionBoundaryDecision>
  readonly backupBeforeRestore?: boolean
}

export type VersionScopeBaseline = {
  readonly revisionRef: string
  readonly paths: readonly {
    readonly relativePath: string
    readonly worktree: string | null
    readonly stage: string | null
  }[]
}

export type VersionCommitExecution =
  | { readonly state: '已提交'; readonly revisionRef: string; readonly changedAt: string }
  | { readonly state: '无变更'; readonly revisionRef: string; readonly changedAt: string }
  | { readonly state: '待核对' }

export type VersionRollbackRequest = {
  readonly projectId: string
  readonly operationId: string
  readonly ownedPaths: readonly string[]
  readonly verify: (observation: VersionRollbackObservation) => Promise<VersionBoundaryDecision>
  readonly backupBeforeRestore?: boolean
}

export type VersionRollbackExecution =
  | {
      readonly state: '已回退'
      readonly originalRevisionRef: string
      readonly revisionRef: string
      readonly changedAt: string
    }
  | { readonly state: '待核对' }
