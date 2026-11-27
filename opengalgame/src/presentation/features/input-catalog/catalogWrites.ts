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
import { AppException } from '@common/errors/AppException'
import { failureOf, requireSuccess, type FailureState } from '../../feedback/failure'
import {
  CATALOG_WRITE_FAILED_CODE,
  COMMIT_UNCLEAR_CODE,
  COMMUNICATION_FAILED_CODE
} from '../../feedback/projectFilesFeedback'
import { workbenchFeedback } from '../../feedback/workbenchFeedback'
import { findFreeCanvasPosition } from '../scene-canvas/canvasPlacement'
import { defaultCardSize, sourceCardKindOf } from '../workbench-session/contentKindLabel'
import { getActiveWorkbenchCommands } from '../workbench-session/workbenchCommands'
import type { ImportedSourcesHandler } from '../workbench-session/workbenchActionObservers'
import { useWorkbenchSessionStore } from '../workbench-session/workbenchSession.store'
import {
  catalogVersion,
  projectInputSourcesQueryKey,
  reloadCatalog,
  stillCurrentProject
} from './catalogSession'
import { inputCatalogMediaKindOf } from './inputCatalogMediaAvailability'
import type {
  CatalogFolderId,
  CatalogImportedSource,
  CatalogImportOptions,
  CatalogImportOutcome,
  CatalogNameDialog
} from './inputCatalog.types'

let writeInFlight = false
const unresolvedCatalogProjects = new Map<string, Set<string>>()

export function isUncertainCatalogWrite(failure: FailureState): boolean {
  return failure.code === COMMIT_UNCLEAR_CODE || failure.code === COMMUNICATION_FAILED_CODE
}

function rememberUnresolved(projectId: string, operationId: string): void {
  const ids = unresolvedCatalogProjects.get(projectId) ?? new Set<string>()
  ids.add(operationId)
  unresolvedCatalogProjects.set(projectId, ids)
}

function clearUnresolved(projectId: string, operationId: string): void {
  const ids = unresolvedCatalogProjects.get(projectId)
  if (!ids) return
  ids.delete(operationId)
  if (ids.size === 0) unresolvedCatalogProjects.delete(projectId)
}

export function catalogProjectNeedsRecovery(projectId: string): boolean {
  return (unresolvedCatalogProjects.get(projectId)?.size ?? 0) > 0
}

export async function resolveCatalogWrite(
  client: ProjectFilesClient,
  projectId: string,
  operationId: string
): Promise<'committed'> {
  let fact: {
    settlement: 'committed' | 'notCommitted' | 'notStarted' | 'unsettled'
    linked: boolean
  }
  try {
    fact = requireSuccess(await client.readProjectFileOperation({ projectId, operationId }))
  } catch (error) {
    rememberUnresolved(projectId, operationId)
    throw new AppException({
      code: COMMIT_UNCLEAR_CODE,
      msg: workbenchFeedback.catalogWriteUnverified,
      cause: error
    })
  }
  if (fact.linked && fact.settlement === 'committed') {
    clearUnresolved(projectId, operationId)
    return 'committed'
  }
  if (fact.linked && fact.settlement === 'notCommitted') {
    clearUnresolved(projectId, operationId)
    throw new AppException({
      code: CATALOG_WRITE_FAILED_CODE,
      msg: workbenchFeedback.catalogWriteNotCommitted
    })
  }
  if (fact.linked && fact.settlement === 'notStarted') {
    clearUnresolved(projectId, operationId)
    throw new AppException({
      code: CATALOG_WRITE_FAILED_CODE,
      msg: workbenchFeedback.catalogWriteNotStarted
    })
  }
  rememberUnresolved(projectId, operationId)
  throw new AppException({
    code: COMMIT_UNCLEAR_CODE,
    msg: workbenchFeedback.catalogWriteUnverified
  })
}

async function resolveCatalogWriteOrReport(
  client: ProjectFilesClient,
  projectId: string,
  operationId: string
): Promise<'committed'> {
  try {
    return await resolveCatalogWrite(client, projectId, operationId)
  } catch (error) {
    if (stillCurrentProject(projectId)) toast(failureOf(error).msg)
    throw error
  }
}

export async function settleCatalogProjectAfterOpen(
  client: ProjectFilesClient,
  projectId: string
): Promise<void> {
  const ids = [...(unresolvedCatalogProjects.get(projectId) ?? [])]
  if (ids.length === 0) return
  try {
    const resolved = requireSuccess(
      await client.recoverProjectFileOperations({ projectId, operationIds: ids })
    )
    for (const item of resolved) {
      if (
        item.state === 'committed' ||
        item.state === 'notCommitted' ||
        item.state === 'notStarted'
      ) {
        clearUnresolved(projectId, item.operationId)
      }
    }
  } catch {}
  if (catalogProjectNeedsRecovery(projectId) && stillCurrentProject(projectId)) {
    toast(workbenchFeedback.catalogWriteNeedsRecovery)
  }
}

export function beginCatalogWrite(
  projectId: string,
  busy: boolean,
  setBusy: (value: boolean) => void
): boolean {
  if (busy || writeInFlight) return false
  if (catalogProjectNeedsRecovery(projectId)) {
    if (stillCurrentProject(projectId)) toast(workbenchFeedback.catalogWriteNeedsRecovery)
    return false
  }
  writeInFlight = true
  if (stillCurrentProject(projectId)) setBusy(true)
  return true
}

export function endCatalogWrite(projectId: string, setBusy: (value: boolean) => void): void {
  writeInFlight = false
  if (stillCurrentProject(projectId)) setBusy(false)
}

export async function importDroppedFiles(
  client: ProjectFilesClient,
  queryClient: QueryClient,
  projectId: string,
  parentFolderId: CatalogFolderId,
  fileList: FileList,
  busy: boolean,
  setBusy: (value: boolean) => void,
  onImported?: ImportedSourcesHandler
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
    await importLocalPaths(client, queryClient, projectId, parentFolderId, paths, onImported)
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
  setBusy: (value: boolean) => void,
  onImported?: ImportedSourcesHandler,
  options?: CatalogImportOptions
): Promise<CatalogImportOutcome> {
  if (projectId.length === 0) return { status: 'not-started' }
  if (!beginCatalogWrite(projectId, busy, setBusy)) return { status: 'not-started' }
  try {
    let chosen: readonly string[] | null
    try {
      const request =
        options?.mediaKinds && options.mediaKinds.length > 0
          ? { mediaKinds: options.mediaKinds }
          : null
      chosen = requireSuccess(
        request === null
          ? await client.chooseProjectFiles()
          : await client.chooseProjectFiles(request)
      )
    } catch (error) {
      // 选择器或浏览器暂存失败发生在工程写入之前，不能算作写入结果不明。
      if (!stillCurrentProject(projectId)) return { status: 'not-started' }
      toast(failureOf(error).msg)
      return { status: 'failed' }
    }
    if (chosen === null) return { status: 'cancelled' }
    if (!stillCurrentProject(projectId)) return { status: 'not-started' }
    return await importLocalPaths(client, queryClient, projectId, parentFolderId, chosen, onImported)
  } catch (error) {
    const failure = failureOf(error)
    if (isUncertainCatalogWrite(failure)) return { status: 'unconfirmed' }
    if (failure.code === CATALOG_WRITE_FAILED_CODE) throw error
    if (stillCurrentProject(projectId)) toast(failure.msg)
    return { status: 'failed' }
  } finally {
    endCatalogWrite(projectId, setBusy)
  }
}

function importOperationIds(localFilePaths: readonly string[]): string[] {
  const batchId = crypto.randomUUID()
  return localFilePaths.map((_, index) => `${batchId}-${index + 1}`)
}

type ImportRecovery = {
  readonly committed: number
  readonly definiteFailed: readonly string[]
  readonly unverified: readonly string[]
  readonly pending: boolean
}

function fileNameOf(localFilePath: string): string {
  return localFilePath.split(/[\\/]/u).at(-1) || localFilePath
}

async function resolveImportOperations(
  client: ProjectFilesClient,
  projectId: string,
  operationIds: readonly string[],
  localFilePaths: readonly string[]
): Promise<ImportRecovery> {
  let resolved: Awaited<ReturnType<ProjectFilesClient['recoverProjectFileOperations']>>['data']
  try {
    resolved = requireSuccess(
      await client.recoverProjectFileOperations({ projectId, operationIds })
    )
  } catch {
    for (const operationId of operationIds) rememberUnresolved(projectId, operationId)
    return {
      committed: 0,
      definiteFailed: [],
      unverified: operationIds.map((_, index) => fileNameOf(localFilePaths[index] ?? '')),
      pending: true
    }
  }
  const states = new Map((resolved ?? []).map((item) => [item.operationId, item.state] as const))
  let committed = 0
  const definiteFailed: string[] = []
  const unverified: string[] = []
  let pending = false
  for (const [index, operationId] of operationIds.entries()) {
    const fileName = fileNameOf(localFilePaths[index] ?? '')
    const state = states.get(operationId)
    if (state === 'committed') {
      committed += 1
      clearUnresolved(projectId, operationId)
    } else if (state === 'notCommitted') {
      definiteFailed.push(fileName)
      clearUnresolved(projectId, operationId)
    } else if (state === 'notStarted') {
      unverified.push(fileName)
      clearUnresolved(projectId, operationId)
    } else {
      rememberUnresolved(projectId, operationId)
      unverified.push(fileName)
      pending = true
    }
  }
  return { committed, definiteFailed, unverified, pending }
}

/**
 * 提交不明时按操作标识恢复。恢复结果只有操作状态，没有操作到来源明细的可靠
 * 映射；因此即使有已提交项也只重载目录并返回 unconfirmed，不按目录差集推断
 * 本次目标类别，也不发布假的 sourceImported。重载后的来源仍可供用户实际拖卡。
 */
async function importLocalPaths(
  client: ProjectFilesClient,
  queryClient: QueryClient,
  projectId: string,
  parentFolderId: CatalogFolderId,
  localFilePaths: readonly string[],
  onImported?: ImportedSourcesHandler
): Promise<CatalogImportOutcome> {
  const operationIds = importOperationIds(localFilePaths)
  let recovery: ImportRecovery | null = null
  let pendingError: AppException | null = null
  let outcome: CatalogImportOutcome = { status: 'none' }
  try {
    const catalog = queryClient.getQueryData<ProjectInputCatalogVO>(
      projectInputSourcesQueryKey(projectId)
    )
    const result = requireSuccess(
      await client.importProjectFiles({
        projectId,
        operationIds,
        localFilePaths,
        parentFolderId,
        expectedCatalogVersion: catalog?.catalogVersion ?? ''
      })
    )
    if (stillCurrentProject(projectId)) {
      toastImportResult(result)
      const sources = importedSourcesOf(projectId, result)
      if (sources.length > 0) {
        onImported?.(sources)
        outcome = { status: 'imported', sources }
      }
    }
  } catch (error) {
    const failure = failureOf(error)
    if (isUncertainCatalogWrite(failure)) {
      recovery = await resolveImportOperations(client, projectId, operationIds, localFilePaths)
      if (stillCurrentProject(projectId)) {
        if (recovery.committed > 0) {
          toast(workbenchFeedback.importImported(recovery.committed))
        }
        for (const fileName of recovery.definiteFailed) {
          toast(workbenchFeedback.importFailedItem(fileName, '提交未完成，请重试'))
        }
        for (const fileName of recovery.unverified) {
          toast(workbenchFeedback.importUnverifiedItem(fileName))
        }
        if (recovery.pending) toast(workbenchFeedback.catalogWriteNeedsRecovery)
      }
      if (recovery.pending) {
        pendingError = new AppException({
          code: COMMIT_UNCLEAR_CODE,
          msg: workbenchFeedback.catalogWriteNeedsRecovery
        })
      }
    } else if (stillCurrentProject(projectId)) {
      toast(failure.msg)
    }
  }
  if (stillCurrentProject(projectId)) {
    await reloadCatalog(client, queryClient, projectId)
    if (recovery) {
      outcome =
        recovery.pending || recovery.committed > 0
          ? { status: 'unconfirmed' }
          : { status: 'none' }
    }
  }
  if (pendingError) throw pendingError
  return outcome
}

function toastImportResult(result: ImportProjectFilesVO): void {
  if (result.importedFiles.length > 0) {
    toast(workbenchFeedback.importImported(result.importedFiles.length))
  }
  for (const file of result.failedFiles) {
    toast(workbenchFeedback.importFailedItem(file.fileName, file.message))
  }
}

function importedSourcesOf(
  projectId: string,
  result: ImportProjectFilesVO
): readonly CatalogImportedSource[] {
  return result.importedFiles.map((source) => ({
    projectId,
    sourceId: source.sourceId,
    contentKind: source.contentKind,
    candidateKind: inputCatalogMediaKindOf(source)
  }))
}

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
  const operationId = crypto.randomUUID()
  const applySuccess = (): void => {
    if (!stillCurrentProject(projectId)) return
    setDialog(null)
    toast(
      dialog.kind === 'rename-file'
        ? workbenchFeedback.fileRenamed
        : dialog.kind === 'rename-folder'
          ? workbenchFeedback.folderRenamed
          : workbenchFeedback.folderCreated
    )
  }
  try {
    const expectedCatalogVersion = catalogVersion(queryClient, projectId)
    if (dialog.kind === 'rename-file') {
      requireSuccess(
        await client.renameProjectFile({
          projectId,
          operationId,
          sourceId: dialog.sourceId,
          newFileName: dialog.name,
          expectedCatalogVersion
        })
      )
    } else if (dialog.kind === 'rename-folder') {
      requireSuccess(
        await client.renameProjectFolder({
          projectId,
          operationId,
          folderId: dialog.folderId,
          newName: dialog.name,
          expectedCatalogVersion
        })
      )
    } else {
      requireSuccess(
        await client.createProjectFolder({
          projectId,
          operationId,
          parentFolderId: dialog.parentFolderId,
          name: dialog.name,
          expectedCatalogVersion
        })
      )
    }
    applySuccess()
  } catch (error) {
    const failure = failureOf(error)
    if (isUncertainCatalogWrite(failure)) {
      try {
        await resolveCatalogWriteOrReport(client, projectId, operationId)
      } catch (verifyError) {
        if (stillCurrentProject(projectId)) {
          setDialog({ ...dialog, error: failureOf(verifyError).msg })
        }
        throw verifyError
      }
      applySuccess()
    } else if (stillCurrentProject(projectId)) {
      setDialog({ ...dialog, error: failure.msg })
    }
  } finally {
    if (stillCurrentProject(projectId)) {
      await reloadCatalog(client, queryClient, projectId)
    }
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
  const operationId = crypto.randomUUID()
  const applySuccess = (): void => {
    if (!stillCurrentProject(projectId)) return
    setDeleteTarget(null)
    toast(workbenchFeedback.fileDeleted)
  }
  try {
    requireSuccess(
      await client.deleteProjectFile({
        projectId,
        operationId,
        sourceId: target.sourceId,
        expectedCatalogVersion: catalogVersion(queryClient, projectId)
      })
    )
    applySuccess()
  } catch (error) {
    const failure = failureOf(error)
    if (isUncertainCatalogWrite(failure)) {
      await resolveCatalogWriteOrReport(client, projectId, operationId)
      applySuccess()
    } else if (stillCurrentProject(projectId)) {
      toast(failure.msg)
    }
  } finally {
    if (stillCurrentProject(projectId)) {
      await reloadCatalog(client, queryClient, projectId)
    }
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
  const operationId = crypto.randomUUID()
  const applySuccess = (): void => {
    if (!stillCurrentProject(projectId)) return
    setPlan(null)
    toast(workbenchFeedback.folderDeleted)
  }
  try {
    requireSuccess(
      await client.deleteProjectFolder({
        projectId,
        operationId,
        folderId: plan.folderId,
        expectedCatalogVersion: plan.catalogVersion,
        expectedDeletionVersion: plan.deletionVersion
      })
    )
    applySuccess()
  } catch (error) {
    const failure = failureOf(error)
    if (isUncertainCatalogWrite(failure)) {
      await resolveCatalogWriteOrReport(client, projectId, operationId)
      applySuccess()
    } else if (stillCurrentProject(projectId)) {
      toast(failure.msg)
    }
  } finally {
    if (stillCurrentProject(projectId)) {
      await reloadCatalog(client, queryClient, projectId)
    }
    endCatalogWrite(projectId, setBusy)
  }
}
