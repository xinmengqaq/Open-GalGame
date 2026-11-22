import type { VersionTarget } from './VersionTarget'

export type VersionSaveMode = 'manual' | 'system'

export type VersionContentSource = 'operation' | 'ai'

export type InitializeWorkBaselineDTO = {
  projectId: string
  initialPaths: readonly string[]
}

export type PrepareCallerVersionOperationDTO = PrepareVersionOperationDTO & {
  callerOperationId: string
}

export type PrepareVersionOperationDTO = {
  projectId: string
  sourceModule: string
  targets: readonly VersionTarget[]
  changePaths: readonly string[]
  watchedPaths: readonly string[]
}

export type BindCallerVersionOperationDTO = {
  projectId: string
  sourceModule: string
  callerOperationId: string
  operationId: string
  targets: readonly VersionTarget[]
  changePaths: readonly string[]
  watchedPaths: readonly string[]
}

export type ReadCallerVersionOperationDTO = {
  projectId: string
  sourceModule: string
  callerOperationId: string
}

export type FindCallerVersionOperationDTO = {
  sourceModule: string
  callerOperationId: string
}

export type VersionScopeBaselineDTO = {
  revisionRef: string
  paths: readonly {
    relativePath: string
    worktree: string | null
    stage: string | null
  }[]
}

export type CommitVersionOperationDTO = {
  projectId: string
  operationId: string
  callerOperationId?: string
  baselineRef: string
  input: FileChangesInputDTO | ImmutableCandidateInputDTO
  scopeBaseline?: VersionScopeBaselineDTO
  saveMode: VersionSaveMode
  contentSource: VersionContentSource
  title: string
  summary: string
}

export type ReadVersionOperationDTO = {
  projectId: string
  operationId: string
}

export type RollbackVersionOperationDTO = {
  projectId: string
  operationId: string
}

export type PruneVersionRecordsDTO = {
  projectId: string
}

export type FileChangesInputDTO = {
  kind: 'files'
  changes: readonly VersionFileChange[]
}

export type ImmutableCandidateInputDTO = {
  kind: 'candidate'
  candidateRef: string
  changes: readonly VersionPathChange[]
}

export type VersionPathChange = {
  relativePath: string
  action: 'add' | 'modify' | 'delete'
}

export type VersionFileChange =
  | {
      relativePath: string
      action: 'add' | 'modify'
      content: VersionContentInput
    }
  | {
      relativePath: string
      action: 'delete'
    }

export type VersionContentInput =
  { kind: 'bytes'; bytes: Uint8Array } | { kind: 'prepared'; contentRef: string }

export type ListVersionHistoryDTO = {
  projectId: string
  sourceModule?: string
  target?: VersionTarget
  saveMode?: VersionSaveMode
  contentSource?: VersionContentSource
  cursor?: string
  pageSize: number
}

export type UndoVersionHistoryDTO = {
  projectId: string
  historyId: string
}

export type ClearVersionHistoryDTO = {
  projectId: string
  selection:
    | { kind: 'entry'; historyId: string }
    | {
        kind: 'category'
        saveMode: VersionSaveMode
        throughHistoryId: string
        sourceModule?: string
        target?: VersionTarget
        contentSource?: VersionContentSource
      }
}
