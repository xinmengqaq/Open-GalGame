export interface ContentPresence {
  readonly exists: boolean
  readonly digest: string | null
}

export interface WorkPathState {
  readonly relativePath: string
  readonly head: ContentPresence
  readonly stage: ContentPresence
  readonly worktree: ContentPresence
}

export interface WorkBaseline {
  readonly headCommitId: string
  readonly branch: string | null
  readonly paths: readonly WorkPathState[]
}

export interface WorkPathChange {
  readonly relativePath: string
  readonly action: 'add' | 'modify' | 'delete'
}

export interface CandidateRevisionRef {
  readonly gitDir: string
  readonly revisionId: string
}

export interface LimitedCommitRequest {
  readonly projectRoot: string
  readonly operationId: string
  readonly sourceModule: string
  readonly expectedBaseline: WorkBaseline
  readonly changes: readonly WorkPathChange[]
  readonly candidate: CandidateRevisionRef
  readonly recheck: (baseline: WorkBaseline) => void | Promise<void>
  readonly advanceBaseline?: boolean
  readonly backupBeforeRestore?: boolean
}

export type OperationCommitState =
  | { readonly state: 'notCommitted' }
  | { readonly state: 'committed'; readonly commitId: string }
  | { readonly state: 'rollbackRequired'; readonly commitId: string }
  | { readonly state: 'rolledBack'; readonly commitId: string; readonly rollbackCommitId: string }
  | { readonly state: 'unknown'; readonly detail: string }

export interface GitRepository {
  readBaseline(projectRoot: string, relativePaths: readonly string[]): Promise<WorkBaseline>

  commitChanges(request: LimitedCommitRequest): Promise<{ commitId: string }>

  readOperation(projectRoot: string, operationId: string): Promise<OperationCommitState>

  rollbackOperation(projectRoot: string, operationId: string): Promise<{ rollbackCommitId: string }>
}
