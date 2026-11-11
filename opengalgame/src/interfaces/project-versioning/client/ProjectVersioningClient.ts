import type {
  ClearVersionHistoryDTO,
  ListVersionHistoryDTO,
  UndoVersionHistoryDTO
} from '@application/project-versioning/dto/ProjectVersioningDTO'
import type {
  VersionHistoryClearVO,
  VersionHistoryPageVO,
  VersionHistoryUndoVO
} from '@application/project-versioning/vo/VersionHistoryVO'
import type { AjaxResult } from '@common/contracts/AjaxResult'

/** 工作台可依赖的用户历史入口。只承载读取、撤销单次操作和清理。 */
export interface ProjectVersioningClient {
  /** 按工程和筛选条件读取用户历史。 */
  listHistory(request: ListVersionHistoryDTO): Promise<AjaxResult<VersionHistoryPageVO>>

  /** 撤销一条用户历史对应的单次操作。 */
  undoHistoryEntry(request: UndoVersionHistoryDTO): Promise<AjaxResult<VersionHistoryUndoVO>>

  /** 清理一条或已确认边界内的用户历史。 */
  clearHistory(request: ClearVersionHistoryDTO): Promise<AjaxResult<VersionHistoryClearVO>>
}
