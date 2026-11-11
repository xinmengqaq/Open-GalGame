import type { QueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'

import type {
  ProjectFolderDeletionPlanVO,
  ProjectInputCatalogVO
} from '@application/project-files/vo/ProjectInputCatalogVO'
import type {
  ImportProjectFilesVO,
  ProjectInputSourceSummaryVO
} from '@application/project-files/vo/ProjectInputSourceVO'
import type { ProjectFilesClient } from '@interfaces/project-files/client/ProjectFilesClient'
import { failureOf, requireSuccess, type FailureState } from '../../feedback/failure'
import { workbenchFeedback } from '../../feedback/workbenchFeedback'
import { findFreeCanvasPosition } from '../scene-canvas/canvasPlacement'
import { defaultCardSize, sourceCardKindOf } from '../workbench-session/contentKindLabel'
import { getActiveWorkbenchCommands } from '../workbench-session/workbenchCommands'
import { useWorkbenchSessionStore } from '../workbench-session/workbenchSession.store'
import {
  catalogVersion,
  projectInputSourcesQueryKey,
  reloadCatalog,
  stillCurrentProject
} from './catalogSession'
import type { CatalogFolderId, CatalogNameDialog } from './inputCatalog.types'

let writeInFlight = false
let unresolvedHold: { projectId: string; operationId: string } | null = null

/**
 * 该工程是否还有未核对的结果不明写入。
 * @returns 未按操作标识核对完时为 true。其他工程不受影响。
 */
export function catalogWriteBlockedFor(projectId: string): boolean {
  return unresolvedHold?.projectId === projectId
}

/** 尚未核对的操作标识。没有门闩时为 null。 */
export function unresolvedCatalogHold(): { projectId: string; operationId: string } | null {
  return unresolvedHold
}

/** 结果不明时按工程和操作标识保持门闩。换工程不能清掉。 */
export function holdUnresolvedCatalogWrite(projectId: string, operationId: string): void {
  unresolvedHold = { projectId, operationId }
}

/** 只有查到已提交或未提交才放下对应工程的门闩。 */
export function releaseCatalogWriteHold(
  projectId: string,
  operationId: string,
  settlement: 'committed' | 'notCommitted' | 'unsettled',
  setBusy: (value: boolean) => void
): boolean {
  if (
    unresolvedHold?.projectId !== projectId ||
    unresolvedHold.operationId !== operationId ||
    (settlement !== 'committed' && settlement !== 'notCommitted')
  ) {
    return false
  }
  unresolvedHold = null
  setBusy(false)
  return true
}

/** 同一事件循环内只允许一次写入。未核对完的工程继续拒绝。 */
export function beginCatalogWrite(
  projectId: string,
  busy: boolean,
  setBusy: (value: boolean) => void
): boolean {
  if (busy || writeInFlight || catalogWriteBlockedFor(projectId)) return false
  writeInFlight = true
  setBusy(true)
  return true
}

/** 释放进行中的写入。未核对完的工程仍保持忙碌。 */
export function endCatalogWrite(projectId: string, setBusy: (value: boolean) => void): void {
  writeInFlight = false
  setBusy(catalogWriteBlockedFor(projectId))
}

/** 回到未核对的工程时查询持久事实。查到已提交或未提交才放下门闩。 */
export async function settleUnresolvedCatalogWrite(
  client: ProjectFilesClient,
  projectId: string,
  setBusy: (value: boolean) => void
): Promise<void> {
  const hold = unresolvedCatalogHold()
  if (!hold || hold.projectId !== projectId) return
  setBusy(true)
  try {
    const fact = requireSuccess(
      await client.readProjectFileOperation({ projectId, operationId: hold.operationId })
    )
    releaseCatalogWriteHold(projectId, hold.operationId, fact.settlement, setBusy)
  } catch {
    setBusy(catalogWriteBlockedFor(projectId))
  }
}

/** 把拖入的外部文件转成路径后导入。转换失败逐项提示，成功路径走同一导入。 */
export async function importDroppedFiles(
  client: ProjectFilesClient,
  queryClient: QueryClient,
  projectId: string,
  parentFolderId: CatalogFolderId,
  fileList: FileList,
  busy: boolean,
  setBusy: (value: boolean) => void
): Promise<void> {
  if (projectId.length === 0 || fileList.length === 0) return
  if (!beginCatalogWrite(projectId, busy, setBusy)) return
  try {
    const paths: string[] = []
    const conversionFailures: FailureState[] = []
    for (const file of fileList) {
      try {
        paths.push(requireSuccess(await client.pathForDroppedFile(file)))
      } catch (error) {
        conversionFailures.push(failureOf(error))
      }
    }
    if (!stillCurrentProject(projectId)) return
    for (const failure of conversionFailures) toast(failure.msg)
    if (paths.length === 0) return
    await importLocalPaths(client, queryClient, projectId, parentFolderId, paths)
  } finally {
    endCatalogWrite(projectId, setBusy)
  }
}

export async function chooseAndImport(
  client: ProjectFilesClient,
  queryClient: QueryClient,
  projectId: string,
  parentFolderId: CatalogFolderId,
  busy: boolean,
  setBusy: (value: boolean) => void
): Promise<void> {
  if (projectId.length === 0) return
  if (!beginCatalogWrite(projectId, busy, setBusy)) return
  try {
    const chosen = requireSuccess(await client.chooseProjectFiles())
    if (chosen === null || !stillCurrentProject(projectId)) return
    await importLocalPaths(client, queryClient, projectId, parentFolderId, chosen)
  } catch (error) {
    if (stillCurrentProject(projectId)) toast(failureOf(error).msg)
  } finally {
    endCatalogWrite(projectId, setBusy)
  }
}

async function importLocalPaths(
  client: ProjectFilesClient,
  queryClient: QueryClient,
  projectId: string,
  parentFolderId: CatalogFolderId,
  localFilePaths: readonly string[]
): Promise<void> {
  try {
    const catalog = queryClient.getQueryData<ProjectInputCatalogVO>(
      projectInputSourcesQueryKey(projectId)
    )
    const result = requireSuccess(
      await client.importProjectFiles({
        projectId,
        localFilePaths,
        parentFolderId,
        expectedCatalogVersion: catalog?.catalogVersion ?? ''
      })
    )
    if (stillCurrentProject(projectId)) toastImportResult(result)
  } catch (error) {
    if (stillCurrentProject(projectId)) toast(failureOf(error).msg)
  }
  if (stillCurrentProject(projectId)) await reloadCatalog(client, queryClient, projectId)
}

function toastImportResult(result: ImportProjectFilesVO): void {
  if (result.importedFiles.length > 0) {
    toast(workbenchFeedback.importImported(result.importedFiles.length))
  }
  for (const file of result.failedFiles) {
    toast(workbenchFeedback.importFailedItem(file.fileName, file.message))
  }
}

/** 可读取来源的双击只打开系统程序。画布挂接不走这里。 */
export function openReadableSource(
  source: { readable: boolean; sourceId: string },
  openSource: (sourceId: string) => void
): void {
  if (source.readable) openSource(source.sourceId)
}

/** 用系统默认程序打开工程文件。 */
export async function openSourceFile(
  client: ProjectFilesClient,
  projectId: string,
  sourceId: string
): Promise<void> {
  if (projectId.length === 0) return
  try {
    requireSuccess(await client.openProjectFile({ projectId, sourceId }))
  } catch (error) {
    toast(failureOf(error).msg)
  }
}

let placeQueue: Promise<void> = Promise.resolve()

/** 把可读取来源挂到当前画布视口附近，优先落在不与已有卡片重叠的位置。 */
export async function placeSourceOnCanvas(sourceId: string): Promise<void> {
  const projectId = useWorkbenchSessionStore.getState().projectId
  const run = placeQueue.then(
    () => placeSourceOnCanvasNow(projectId, sourceId),
    () => placeSourceOnCanvasNow(projectId, sourceId)
  )
  placeQueue = run.then(
    () => undefined,
    () => undefined
  )
  await run
}

async function placeSourceOnCanvasNow(projectId: string, sourceId: string): Promise<void> {
  const commands = getActiveWorkbenchCommands()
  if (!commands) return
  const state = useWorkbenchSessionStore.getState()
  if (state.projectId !== projectId) return
  const viewport = state.viewport
  const summary = state.sources.find((source) => source.sourceId === sourceId)
  const size = defaultCardSize(summary ? sourceCardKindOf(summary) : 'image')
  const { position, overlapping } = findFreeCanvasPosition(
    state.cards,
    {
      x: -viewport.x / viewport.zoom + 48,
      y: -viewport.y / viewport.zoom + 48
    },
    size
  )
  const previousCardIds = new Set(state.cards.map((card) => card.cardId))
  const result = await commands.createSourceCard(sourceId, position)
  if (result === 'unreadable') {
    toast(workbenchFeedback.dropUnreadable)
    return
  }
  if (result === 'missing') {
    toast(workbenchFeedback.sourceMissing)
    return
  }
  if (result === 'failed') return
  toast(overlapping ? workbenchFeedback.canvasPlacementOverlap : workbenchFeedback.cardAdded)
  const created = useWorkbenchSessionStore
    .getState()
    .cards.find((card) => !previousCardIds.has(card.cardId))
  if (created && (created.kind === 'image' || created.kind === 'video')) {
    await waitForPreviewLayout(created.cardId, created.layout.height)
  }
}

const PREVIEW_LAYOUT_WAIT_MS = 1000
const PREVIEW_LAYOUT_POLL_MS = 40

/** 下一张卡片要避开预览的真实高度；等图片或视频按原始比例回填布局后再继续。 */
async function waitForPreviewLayout(cardId: string, initialHeight: number): Promise<void> {
  const deadline = Date.now() + PREVIEW_LAYOUT_WAIT_MS
  while (Date.now() < deadline) {
    const card = useWorkbenchSessionStore.getState().cards.find((item) => item.cardId === cardId)
    if (!card || Math.abs(card.layout.height - initialHeight) > 1) return
    const { promise, resolve } = Promise.withResolvers<void>()
    setTimeout(resolve, PREVIEW_LAYOUT_POLL_MS)
    await promise
  }
}

export async function submitCatalogName(
  client: ProjectFilesClient,
  queryClient: QueryClient,
  projectId: string,
  dialog: CatalogNameDialog,
  busy: boolean,
  setBusy: (value: boolean) => void,
  setDialog: (value: CatalogNameDialog) => void
): Promise<void> {
  if (!dialog || projectId.length === 0) return
  if (!beginCatalogWrite(projectId, busy, setBusy)) return
  try {
    const expectedCatalogVersion = catalogVersion(queryClient, projectId)
    if (dialog.kind === 'rename-file') {
      requireSuccess(
        await client.renameProjectFile({
          projectId,
          sourceId: dialog.sourceId,
          newFileName: dialog.name,
          expectedCatalogVersion
        })
      )
    } else if (dialog.kind === 'rename-folder') {
      requireSuccess(
        await client.renameProjectFolder({
          projectId,
          folderId: dialog.folderId,
          newName: dialog.name,
          expectedCatalogVersion
        })
      )
    } else {
      requireSuccess(
        await client.createProjectFolder({
          projectId,
          parentFolderId: dialog.parentFolderId,
          name: dialog.name,
          expectedCatalogVersion
        })
      )
      if (stillCurrentProject(projectId)) toast(workbenchFeedback.folderCreated)
    }
    if (!stillCurrentProject(projectId)) return
    setDialog(null)
    await reloadCatalog(client, queryClient, projectId)
  } catch (error) {
    if (stillCurrentProject(projectId)) {
      setDialog({ ...dialog, error: failureOf(error).msg })
    }
  } finally {
    endCatalogWrite(projectId, setBusy)
  }
}

export async function deleteSourceFile(
  client: ProjectFilesClient,
  queryClient: QueryClient,
  projectId: string,
  target: ProjectInputSourceSummaryVO | null,
  busy: boolean,
  setBusy: (value: boolean) => void,
  setDeleteTarget: (value: ProjectInputSourceSummaryVO | null) => void
): Promise<void> {
  if (!target || projectId.length === 0) return
  if (!beginCatalogWrite(projectId, busy, setBusy)) return
  try {
    requireSuccess(
      await client.deleteProjectFile({
        projectId,
        sourceId: target.sourceId,
        expectedCatalogVersion: catalogVersion(queryClient, projectId)
      })
    )
    if (!stillCurrentProject(projectId)) return
    setDeleteTarget(null)
  } catch (error) {
    if (stillCurrentProject(projectId)) toast(failureOf(error).msg)
  } finally {
    if (stillCurrentProject(projectId)) await reloadCatalog(client, queryClient, projectId)
    endCatalogWrite(projectId, setBusy)
  }
}

export async function loadFolderDeletionPlan(
  client: ProjectFilesClient,
  projectId: string,
  folderId: string,
  busy: boolean,
  setBusy: (value: boolean) => void,
  setPlan: (value: ProjectFolderDeletionPlanVO | null) => void
): Promise<void> {
  if (projectId.length === 0) return
  if (!beginCatalogWrite(projectId, busy, setBusy)) return
  try {
    const plan = requireSuccess(await client.readProjectFolderDeletionPlan({ projectId, folderId }))
    if (stillCurrentProject(projectId)) setPlan(plan)
  } catch (error) {
    if (stillCurrentProject(projectId)) toast(failureOf(error).msg)
  } finally {
    endCatalogWrite(projectId, setBusy)
  }
}

export async function confirmFolderDeletion(
  client: ProjectFilesClient,
  queryClient: QueryClient,
  projectId: string,
  plan: ProjectFolderDeletionPlanVO | null,
  busy: boolean,
  setBusy: (value: boolean) => void,
  setPlan: (value: ProjectFolderDeletionPlanVO | null) => void
): Promise<void> {
  if (!plan || projectId.length === 0) return
  if (!beginCatalogWrite(projectId, busy, setBusy)) return
  try {
    requireSuccess(
      await client.deleteProjectFolder({
        projectId,
        folderId: plan.folderId,
        expectedCatalogVersion: plan.catalogVersion,
        expectedDeletionVersion: plan.deletionVersion
      })
    )
    if (!stillCurrentProject(projectId)) return
    setPlan(null)
  } catch (error) {
    if (stillCurrentProject(projectId)) toast(failureOf(error).msg)
  } finally {
    if (stillCurrentProject(projectId)) await reloadCatalog(client, queryClient, projectId)
    endCatalogWrite(projectId, setBusy)
  }
}
