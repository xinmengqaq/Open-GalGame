import type {
  BindCallerVersionOperationDTO,
  ClearVersionHistoryDTO,
  CommitVersionOperationDTO,
  FindCallerVersionOperationDTO,
  InitializeWorkBaselineDTO,
  ListVersionHistoryDTO,
  PrepareVersionOperationDTO,
  PruneVersionRecordsDTO,
  ReadCallerVersionOperationDTO,
  ReadVersionOperationDTO,
  RollbackVersionOperationDTO,
  UndoVersionHistoryDTO
} from '../dto/ProjectVersioningDTO'
import type {
  CallerVersionOperationVO,
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

/**
 * 提交与回滚的唯一用例入口。
 * 内部版本方法只供后端适配器调用；用户历史方法由本模块用户接口转发。
 */
export interface ProjectVersioningApplicationService {
  /** 在工程创建、导入或旧工程首次写入前建立可靠基线。 */
  initializeBaseline(request: InitializeWorkBaselineDTO): Promise<WorkBaselineVO>

  /** 读取已经建立的作品基线。没有基线时返回 null，不创建仓库。 */
  readWorkBaseline(projectId: string): Promise<WorkBaselineVO | null>

  /** 准备本次操作的身份、范围和持久基线。 */
  prepareOperation(request: PrepareVersionOperationDTO): Promise<PreparedVersionOperationVO>

  /** 读取已持久准备的操作。不存在时失败，不生成新的版本身份。 */
  readPreparedOperation(request: ReadVersionOperationDTO): Promise<PreparedVersionOperationVO>

  /**
   * 在提交前持久绑定调用方操作身份和已准备的版本身份。
   * 同一调用方身份只能绑定同一工程、来源、目标和声明范围。
   */
  bindCallerOperation(request: BindCallerVersionOperationDTO): Promise<void>

  /** 按工程和来源读取调用方身份对应的版本身份。没有绑定时返回 null。 */
  readCallerOperation(
    request: ReadCallerVersionOperationDTO
  ): Promise<CallerVersionOperationVO | null>

  /**
   * 按来源读取调用方身份。调用方没有工程时使用。
   * 多个工程同时命中且归属矛盾时失败。
   */
  findCallerOperation(
    request: FindCallerVersionOperationDTO
  ): Promise<CallerVersionOperationVO | null>

  /**
   * 在短提交边界内复核前置条件，并发布声明的文件变更或不可变候选。
   * 前置检查由业务适配器重新提供，不序列化，也不能因回调缺失而跳过。
   */
  commitOperation(
    request: CommitVersionOperationDTO,
    requirePreconditions: () => void | Promise<void>
  ): Promise<VersionCommitVO>

  /** 只读核对本操作的持久结算事实。 */
  readOperationSettlement(request: ReadVersionOperationDTO): Promise<VersionSettlementVO>

  /** 通过追加提交受控回退本操作拥有的修改。 */
  rollbackOperation(request: RollbackVersionOperationDTO): Promise<VersionRollbackVO>

  /** 按工程和筛选条件分页读取用户历史。 */
  listHistory(request: ListVersionHistoryDTO): Promise<VersionHistoryPageVO>

  /** 根据用户历史条目撤销对应的单次操作。 */
  undoHistoryEntry(request: UndoVersionHistoryDTO): Promise<VersionHistoryUndoVO>

  /** 清理单条或已确认类别范围的用户历史。 */
  clearHistory(request: ClearVersionHistoryDTO): Promise<VersionHistoryClearVO>

  /** 在结算后安全维护超额历史和无引用操作记录。 */
  pruneOperationRecords(request: PruneVersionRecordsDTO): Promise<void>
}
