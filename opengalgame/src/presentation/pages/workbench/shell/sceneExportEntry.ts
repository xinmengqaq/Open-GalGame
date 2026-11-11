import type { PreviewSaveVersionVO } from '@application/scene-export/vo/PreviewSaveVersionVO'
import type { AjaxResult } from '@common/contracts/AjaxResult'
import { ErrorCodes } from '@common/errors/ErrorCodes'

import type { WorkbenchSaveState } from '../../../features/workbench-session/workbenchSession.types'
import type { SavedSceneVersionFact } from './WorkbenchPreviewLayer'

/** 这些保存状态下工作台还有未落定的改动，导出会读到不确定的场景内容。 */
const exportSaveBlockedStates: ReadonlySet<WorkbenchSaveState> = new Set([
  'saving',
  'failed',
  'unverified',
  'unsaved',
  'committedUnsubmitted'
])

/** 工作台挂载或切换场景时，把最近一次已结算预览保存读成导出前置。 */
export function latestPreviewSaveOfResult(
  result: AjaxResult<PreviewSaveVersionVO | null>
): PreviewSaveVersionVO | null {
  if (result.code !== ErrorCodes.success || result.data === undefined) return null
  return result.data
}

/**
 * 把已结算的预览保存转成导出所需的保存事实。
 * 只认身份与内容依据，不补 revision；身份不完整时按未保存处理。
 */
export function savedSceneVersionOfPreviewSave(
  version: PreviewSaveVersionVO | null
): SavedSceneVersionFact | null {
  if (version === null) return null
  const requestId = version.requestId.trim()
  const contentDigest = version.contentBasis.digest.trim()
  if (requestId === '' || contentDigest === '') return null
  return { requestId, contentBasis: { ...version.contentBasis, digest: contentDigest } }
}

/** 导出入口的可见性与提示只由当前工作台状态决定，顶栏与已提交气泡共用。 */
export interface SceneExportEntryState {
  readonly savedSceneVersion: SavedSceneVersionFact | null
  readonly exporting: boolean
  readonly pageBlocked: boolean
  readonly workspaceBlocked: boolean
  readonly generationActive: boolean
  readonly viewStale: boolean
  readonly saveState: WorkbenchSaveState
  /** 工作台保存状态标签，用于拼出“先处理后再导出”的提示。 */
  readonly saveLabel: string
}

export interface SceneExportEntry {
  readonly canRun: boolean
  readonly hint: string
}

export function sceneExportEntryOf(state: SceneExportEntryState): SceneExportEntry {
  const exportSaveBlocked = exportSaveBlockedStates.has(state.saveState)
  const canRun =
    state.savedSceneVersion !== null &&
    !state.exporting &&
    !state.pageBlocked &&
    !state.workspaceBlocked &&
    !state.generationActive &&
    !state.viewStale &&
    !exportSaveBlocked
  const hint = state.exporting
    ? '正在导出当前场景…'
    : state.savedSceneVersion === null
      ? '还没有保存成功的场景内容；先在试玩预览里保存一次'
      : state.viewStale
        ? '工作台正在恢复历史视图，暂不导出'
        : state.generationActive
          ? '生成进行中，暂不导出'
          : exportSaveBlocked
            ? `工作台保存状态是“${state.saveLabel}”，先处理后再导出`
            : state.saveState === 'dirty'
              ? '先保存工作台改动，再导出已保存的当前场景'
              : '导出已保存的当前场景为 Windows WebGAL 游戏'
  return { canRun, hint }
}
