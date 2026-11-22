import type { ImmutableCandidateInputDTO, FileChangesInputDTO } from '../dto/ProjectVersioningDTO'

export interface VersionContentGateway {
  retain(input: VersionRetainRequest): Promise<readonly VersionBoundRetention[]>

  release(input: VersionReleaseRequest): Promise<void>
}

export type VersionBoundRetention = {
  readonly relativePath: string
  readonly action: 'add' | 'modify' | 'delete'
  readonly retentionRef: string | null
}

export type VersionRetainRequest = {
  readonly projectId: string
  readonly operationId: string
  readonly fingerprint: string
  readonly input: FileChangesInputDTO | ImmutableCandidateInputDTO
}

export type VersionReleaseRequest = {
  readonly projectId: string
  readonly operationId: string
  readonly retentionRefs: readonly string[]
}
