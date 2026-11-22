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

export interface ProjectVersioningClient {
  listHistory(request: ListVersionHistoryDTO): Promise<AjaxResult<VersionHistoryPageVO>>

  undoHistoryEntry(request: UndoVersionHistoryDTO): Promise<AjaxResult<VersionHistoryUndoVO>>

  clearHistory(request: ClearVersionHistoryDTO): Promise<AjaxResult<VersionHistoryClearVO>>
}
