import type {
  BindCallerVersionOperationDTO,
  ClearVersionHistoryDTO,
  CommitVersionOperationDTO,
  FindCallerVersionOperationDTO,
  InitializeWorkBaselineDTO,
  ListVersionHistoryDTO,
  PrepareCallerVersionOperationDTO,
  PrepareVersionOperationDTO,
  PruneVersionRecordsDTO,
  ReadCallerVersionOperationDTO,
  ReadVersionOperationDTO,
  RollbackVersionOperationDTO,
  UndoVersionHistoryDTO
} from '../dto/ProjectVersioningDTO'
import type {
  CallerVersionOperationVO,
  CallerOperationState,
  PreparedVersionOperationVO,
  VersionCommitVO,
  VersionRollbackVO,
  VersionSettlementVO,
  WorkBaselineVO
} from '../vo/ProjectVersioningVO'
import type {
  VersionHistoryClearVO,
  VersionHistoryPageVO,
  VersionHistoryUndoVO
} from '../vo/VersionHistoryVO'

export interface ProjectVersioningApplicationService {
  initializeBaseline(request: InitializeWorkBaselineDTO): Promise<WorkBaselineVO>

  readWorkBaseline(projectId: string): Promise<WorkBaselineVO | null>

  prepareOperation(request: PrepareVersionOperationDTO): Promise<PreparedVersionOperationVO>

  prepareOrClaimCallerOperation(
    request: PrepareCallerVersionOperationDTO
  ): Promise<PreparedVersionOperationVO>

  readPreparedOperation(request: ReadVersionOperationDTO): Promise<PreparedVersionOperationVO>

  bindCallerOperation(request: BindCallerVersionOperationDTO): Promise<void>

  readCallerOperation(
    request: ReadCallerVersionOperationDTO
  ): Promise<CallerVersionOperationVO | null>

  findCallerOperation(
    request: FindCallerVersionOperationDTO
  ): Promise<CallerVersionOperationVO | null>

  commitOperation(
    request: CommitVersionOperationDTO,
    requirePreconditions: () => void | Promise<void>
  ): Promise<VersionCommitVO>

  readOperationSettlement(request: ReadVersionOperationDTO): Promise<VersionSettlementVO>

  recoverProject(projectId: string, sourceModule: string): Promise<void>

  resolveCallerOperations(
    projectId: string,
    sourceModule: string,
    callerOperationIds: readonly string[]
  ): Promise<readonly { callerOperationId: string; state: CallerOperationState }[]>

  readCallerIdentity(
    projectId: string,
    sourceModule: string,
    callerOperationId: string
  ): Promise<{
    operationId: string
    state: CallerOperationState
    contentFingerprint: string | null
  } | null>

  rollbackOperation(request: RollbackVersionOperationDTO): Promise<VersionRollbackVO>

  listHistory(request: ListVersionHistoryDTO): Promise<VersionHistoryPageVO>

  undoHistoryEntry(request: UndoVersionHistoryDTO): Promise<VersionHistoryUndoVO>

  clearHistory(request: ClearVersionHistoryDTO): Promise<VersionHistoryClearVO>

  pruneOperationRecords(request: PruneVersionRecordsDTO): Promise<void>
}
