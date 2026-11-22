import type { SavedSceneVersionVO } from '@application/scene-export/vo/SavedSceneVersionVO'
import type { SceneExportVersionReference } from '@application/scene-export/vo/SceneExportVO'
import type { AjaxResult } from '@common/contracts/AjaxResult'
import { ErrorCodes } from '@common/errors/ErrorCodes'

import type { WorkbenchSaveState } from '@presentation/features/workbench-session/workbenchSession.types'
import type { SavedSceneVersionFact } from './WorkbenchPreviewLayer'

const exportSaveBlockedStates: Partial<Record<WorkbenchSaveState, true>> = {
  saving: true,
  failed: true,
  unverified: true,
  unsaved: true,
  committedUnsubmitted: true
}



/** 工作台挂载、切换场景或生成提交后，把后端最新可导出正式版本读成导出前置。 */
export function latestSavedSceneVersionOfResult(
  result: AjaxResult<SavedSceneVersionVO | null>
): SavedSceneVersionVO | null {
  if (result.code !== ErrorCodes.success || result.data === undefined) return null
  return result.data
}

/**
 * 把已核对的最新正式版本转成导出所需的保存事实。
 * 只认完整身份与内容依据；身份不完整时按没有版本处理。
 */
export function savedSceneVersionOfResult(
  version: SavedSceneVersionVO | null
): SavedSceneVersionFact | null {
  if (version === null) return null
  const contentDigest = version.contentBasis.digest.trim()
  if (contentDigest === '' || !validReference(version.versionReference)) return null
  return {
    versionReference: version.versionReference,
    contentBasis: { ...version.contentBasis, digest: contentDigest }
  }
}

/** 预览保存成功时只接受预览来源；其他来源不在这里伪造。 */
export function savedSceneVersionOfPreviewSave(
  saved: { readonly requestId: string; readonly contentBasis: SavedSceneVersionFact['contentBasis'] }
): SavedSceneVersionFact | null {
  return normalizeSavedSceneVersionFact({
    versionReference: { kind: 'preview-save', requestId: saved.requestId },
    contentBasis: saved.contentBasis
  })
}

export function normalizeSavedSceneVersionFact(
  saved: SavedSceneVersionFact
): SavedSceneVersionFact | null {
  const contentDigest = saved.contentBasis.digest.trim()
  if (contentDigest === '' || !validReference(saved.versionReference)) return null
  return {
    versionReference: saved.versionReference,
    contentBasis: { ...saved.contentBasis, digest: contentDigest }
  }
}

function validReference(reference: SceneExportVersionReference): boolean {
  if (reference.kind === 'preview-save') return reference.requestId.trim() !== ''
  return reference.operationId.trim() !== '' && reference.commitId.trim() !== ''
}

export interface SceneExportEntryState {
  readonly savedSceneVersion: SavedSceneVersionFact | null
  readonly exporting: boolean
  readonly pageBlocked: boolean
  readonly workspaceBlocked: boolean
  readonly generationActive: boolean
  readonly viewStale: boolean
  readonly saveState: WorkbenchSaveState
  readonly saveLabel: string
}

export interface SceneExportEntry {
  readonly canRun: boolean
  readonly hint: string
}

export function sceneExportEntryOf(state: SceneExportEntryState): SceneExportEntry {
  const exportSaveBlocked = exportSaveBlockedStates[state.saveState] === true
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
    : state.viewStale
      ? '工作台正在恢复历史视图，暂不导出'
      : state.generationActive
        ? '生成进行中，暂不导出'
        : exportSaveBlocked
          ? `工作台保存状态是“${state.saveLabel}”，先处理后再导出`
          : state.savedSceneVersion === null
            ? '还没有可导出的已保存场景；先在试玩预览里保存，或接受一次生成结果'
            : state.saveState === 'dirty'
              ? '先保存工作台改动，再导出已保存的当前场景'
              : '导出已保存的当前场景为 Windows WebGAL 游戏'
  return { canRun, hint }
}
