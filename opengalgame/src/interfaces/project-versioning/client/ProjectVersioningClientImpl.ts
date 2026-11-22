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
import { communicationFailureResult } from '../../client/communicationFailure'
import type { DesktopBridge } from '../../client/DesktopBridge'
import {
  parseVersionHistoryClearResult,
  parseVersionHistoryPageResult,
  parseVersionHistoryUndoResult
} from '../contracts/ProjectVersioningResponseSchema'
import type { ProjectVersioningClient } from './ProjectVersioningClient'

async function readVersioningResult<T>(
  action: () => Promise<unknown>,
  parse: (value: unknown) => AjaxResult<T> | null
): Promise<AjaxResult<T>> {
  try {
    const result = parse(await action())
    return result ?? communicationFailureResult()
  } catch {
    return communicationFailureResult()
  }
}

export class ProjectVersioningClientImpl implements ProjectVersioningClient {
  constructor(private readonly bridge: DesktopBridge) {}

  listHistory(request: ListVersionHistoryDTO): Promise<AjaxResult<VersionHistoryPageVO>> {
    return readVersioningResult(
      () => this.bridge.listVersionHistory(request),
      parseVersionHistoryPageResult
    )
  }

  undoHistoryEntry(request: UndoVersionHistoryDTO): Promise<AjaxResult<VersionHistoryUndoVO>> {
    return readVersioningResult(
      () => this.bridge.undoVersionHistoryEntry(request),
      parseVersionHistoryUndoResult
    )
  }

  clearHistory(request: ClearVersionHistoryDTO): Promise<AjaxResult<VersionHistoryClearVO>> {
    return readVersioningResult(
      () => this.bridge.clearVersionHistory(request),
      parseVersionHistoryClearResult
    )
  }
}
