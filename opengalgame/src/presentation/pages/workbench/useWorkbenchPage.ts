import { useQueryClient, type QueryClient } from '@tanstack/react-query'
import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'

import type { ProjectInputCatalogVO } from '@application/project-files/vo/ProjectInputCatalogVO'
import type { ProjectWorkspaceInspectionVO } from '@application/projects/vo/ProjectWorkspaceVO'
import type { ProjectClient } from '@interfaces/client/ProjectClient'
import type { ProjectFilesClient } from '@interfaces/project-files/client/ProjectFilesClient'
import type { SceneCanvasClient } from '@interfaces/scene-canvas/client/SceneCanvasClient'
import { failureOf, requireSuccess } from '../../feedback/failure'
import {
  fetchProjectInputSources,
  projectInputSourcesQueryKey
} from '../../features/input-catalog/useInputCatalog'
import {
  saveFailureText,
  saveStateOfCode,
  type WorkbenchCommands
} from '../../features/workbench-session/workbenchCommands'
import { promptReferenceFailureOf } from '../../features/workbench-session/promptReferences'
import {
  draftArrangementOf,
  snapshotOf
} from '../../features/workbench-session/workbenchSessionMapper'
import { resolveCardSpacing } from '../../features/scene-canvas/cardSpacing'
import {
  sessionIsDirty,
  useWorkbenchSessionStore
} from '../../features/workbench-session/workbenchSession.store'
import {
  isOwnershipMismatch,
  projectFilesFailureMessage
} from '../../feedback/projectFilesFeedback'
import {
  PROJECT_WORKSPACE_NOT_READY_CODE,
  SCENE_CANVAS_OWNERSHIP_MISMATCH_CODE,
  workbenchFeedback
} from '../../feedback/workbenchFeedback'
import { useNavigationStore } from '../../stores/navigation.store'

export function useWorkbenchPage(
  projectClient: ProjectClient,
  projectFilesClient: ProjectFilesClient,
  sceneCanvasClient: SceneCanvasClient,
  commands: WorkbenchCommands
): {
  loadWorkspace: () => Promise<boolean>
  inspectProject: () => Promise<void>
  refreshSources: () => Promise<boolean>
  reloadAfterHistoryUndo: () => Promise<boolean>
  workspaceNotReady: boolean
  workspaceRebuilding: boolean
  workspaceRebuildFailed: boolean
  rebuildWorkspace: () => Promise<boolean>
} {
  const opened = useNavigationStore((state) => state.openedProject)
  const queryClient = useQueryClient()
  const [workspaceNotReady, setWorkspaceNotReady] = useState(false)
  const [workspaceRebuilding, setWorkspaceRebuilding] = useState(false)
  const [workspaceRebuildFailed, setWorkspaceRebuildFailed] = useState(false)
  const rebuildLock = useRef(false)

  useEffect(() => {
    if (!opened) return
    let cancelled = false
    void (async () => {
      const result = await openWorkbenchWorkspace(
        projectClient,
        sceneCanvasClient,
        projectFilesClient,
        queryClient,
        opened.id,
        opened.name
      )
      if (cancelled) return
      setWorkspaceNotReady(!result.workspaceReady)
      setWorkspaceRebuildFailed(false)
    })()
    return () => {
      cancelled = true
      commands.dispose()
      useWorkbenchSessionStore.getState().reset()
    }
  }, [commands, opened, projectClient, projectFilesClient, queryClient, sceneCanvasClient])

  useEffect(() => {
    function onKey(event: KeyboardEvent): void {
      if (fileUiActive()) return
      const store = useWorkbenchSessionStore.getState()
      const typing = isTextEntry(event.target)
      if (event.key === 'Escape' && !typing && store.documentLayerCardId) {
        commands.closeDocumentLayer()
        return
      }
      if (typing) return
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') {
        event.preventDefault()
        if (event.shiftKey) commands.redo()
        else commands.undo()
        return
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'y') {
        event.preventDefault()
        commands.redo()
        return
      }
      if (
        event.key === 'Delete' &&
        !store.documentLayerCardId &&
        store.selectedCardId &&
        !document.querySelector(ACTIVE_DIALOG_SELECTOR)
      ) {
        void commands.deleteCard(store.selectedCardId)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [commands])

  const rebuildWorkspace = useCallback(async (): Promise<boolean> => {
    if (!opened || !beginWorkspaceRebuild(rebuildLock)) return false
    setWorkspaceRebuilding(true)
    setWorkspaceRebuildFailed(false)
    try {
      return await rebuildOpenedWorkspace(
        projectClient,
        projectFilesClient,
        sceneCanvasClient,
        queryClient,
        opened.id,
        opened.name,
        () => useNavigationStore.getState().openedProject?.id === opened.id,
        (phase) => {
          if (phase === 'failed') {
            setWorkspaceNotReady(true)
            setWorkspaceRebuildFailed(true)
            return
          }
          if (phase === 'ready') {
            setWorkspaceNotReady(false)
            return
          }
          if (phase === 'loaded') {
            setWorkspaceNotReady(false)
            setWorkspaceRebuildFailed(false)
          }
        }
      )
    } finally {
      rebuildLock.current = false
      setWorkspaceRebuilding(false)
    }
  }, [opened, projectClient, projectFilesClient, queryClient, sceneCanvasClient])

  return {
    loadWorkspace: () =>
      opened
        ? reloadWorkspace(projectClient, projectFilesClient, sceneCanvasClient, queryClient, opened)
        : Promise.resolve(false),
    inspectProject: () =>
      opened ? inspectProject(projectFilesClient, opened.id) : Promise.resolve(),
    refreshSources: () =>
      opened ? refreshSources(projectFilesClient, queryClient, opened.id) : Promise.resolve(false),
    reloadAfterHistoryUndo: () =>
      opened
        ? reloadWorkspace(
            projectClient,
            projectFilesClient,
            sceneCanvasClient,
            queryClient,
            opened,
            { preserveArrangementOnFailure: true }
          )
        : Promise.resolve(false),
    workspaceNotReady,
    workspaceRebuilding,
    workspaceRebuildFailed,
    rebuildWorkspace
  }
}

function isTextEntry(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement ||
    (target instanceof HTMLElement && target.isContentEditable)
  )
}

const ACTIVE_DIALOG_SELECTOR =
  'dialog[open], [role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"]'

function fileUiActive(): boolean {
  return Boolean(
    document.querySelector(ACTIVE_DIALOG_SELECTOR) ||
    document.querySelector('[data-testid="file-context-menu"]')
  )
}

const WORKSPACE_NOT_READY_MESSAGE = '工程初始化未完成，请重新构建'

async function reloadWorkspace(
  projectClient: ProjectClient,
  projectFilesClient: ProjectFilesClient,
  sceneCanvasClient: SceneCanvasClient,
  queryClient: QueryClient,
  opened: { id: string; name: string },
  options?: { preserveArrangementOnFailure?: boolean }
): Promise<boolean> {
  const inspection = await readWorkspaceInspection(projectClient, opened.id)
  if (!inspection?.ready || !inspection.sceneId || !inspection.canvasId) return false
  if (!adoptWorkspace(opened.id, opened.name, inspection.sceneId, inspection.canvasId)) {
    return false
  }
  return loadWorkspace(projectFilesClient, sceneCanvasClient, queryClient, opened.id, options)
}

async function ensureWorkspace(
  projectClient: ProjectClient,
  projectId: string,
  projectName: string
): Promise<boolean> {
  try {
    const workspace = requireSuccess(await projectClient.ensureProjectWorkspace({ projectId }))
    return adoptWorkspace(projectId, projectName, workspace.sceneId, workspace.canvasId)
  } catch (error) {
    const current = useWorkbenchSessionStore.getState().projectId
    if (current !== '' && current !== projectId) return false
    const failure = failureOf(error)
    const safe =
      failure.code === PROJECT_WORKSPACE_NOT_READY_CODE
        ? { code: failure.code, msg: WORKSPACE_NOT_READY_MESSAGE }
        : failure
    recordWorkspaceFailure(projectId, safe)
    return false
  }
}

/**
 * 打开工作台：已就绪直接加载。
 * 只有还没有画布身份时才 ensure。其余未就绪显示面板，不补建。
 */
export async function openWorkbenchWorkspace(
  projectClient: ProjectClient,
  sceneCanvasClient: SceneCanvasClient,
  projectFilesClient: ProjectFilesClient,
  queryClient: QueryClient,
  projectId: string,
  projectName: string
): Promise<{ workspaceReady: boolean; loaded: boolean }> {
  const inspection = await readWorkspaceInspection(projectClient, projectId)
  if (!inspection) return { workspaceReady: false, loaded: false }
  if (inspection.ready && inspection.sceneId && inspection.canvasId) {
    if (!adoptWorkspace(projectId, projectName, inspection.sceneId, inspection.canvasId)) {
      return { workspaceReady: false, loaded: false }
    }
    const loaded = await loadWorkspace(
      projectFilesClient,
      sceneCanvasClient,
      queryClient,
      projectId
    )
    return { workspaceReady: true, loaded }
  }
  if (!inspection.sceneId || !inspection.canvasId) {
    const ensured = await ensureWorkspace(projectClient, projectId, projectName)
    if (!ensured) return { workspaceReady: false, loaded: false }
    const loaded = await loadWorkspace(
      projectFilesClient,
      sceneCanvasClient,
      queryClient,
      projectId
    )
    return { workspaceReady: true, loaded }
  }
  recordWorkspaceFailure(projectId, {
    code: PROJECT_WORKSPACE_NOT_READY_CODE,
    msg: WORKSPACE_NOT_READY_MESSAGE
  })
  return { workspaceReady: false, loaded: false }
}

/** 显式重新构建或没有画布身份的首次打开：先 ensure，再加载画布。 */
export async function ensureOpenedWorkspace(
  projectClient: ProjectClient,
  sceneCanvasClient: SceneCanvasClient,
  projectFilesClient: ProjectFilesClient,
  queryClient: QueryClient,
  projectId: string,
  projectName: string
): Promise<boolean> {
  const ready = await ensureWorkspace(projectClient, projectId, projectName)
  if (!ready) return false
  return loadWorkspace(projectFilesClient, sceneCanvasClient, queryClient, projectId)
}

async function readWorkspaceInspection(
  projectClient: ProjectClient,
  projectId: string
): Promise<ProjectWorkspaceInspectionVO | null> {
  try {
    const inspection = requireSuccess(await projectClient.inspectProjectWorkspace({ projectId }))
    const current = useWorkbenchSessionStore.getState().projectId
    if (current !== '' && current !== projectId) return null
    return inspection
  } catch (error) {
    const current = useWorkbenchSessionStore.getState().projectId
    if (current !== '' && current !== projectId) return null
    const failure = failureOf(error)
    const safe =
      failure.code === PROJECT_WORKSPACE_NOT_READY_CODE
        ? { code: failure.code, msg: WORKSPACE_NOT_READY_MESSAGE }
        : failure
    recordWorkspaceFailure(projectId, safe)
    return null
  }
}

function adoptWorkspace(
  projectId: string,
  projectName: string,
  sceneId: string,
  canvasId: string
): boolean {
  const current = useWorkbenchSessionStore.getState()
  if (current.projectId !== '' && current.projectId !== projectId) return false
  const keepDraft =
    current.projectId === projectId &&
    current.sceneId === sceneId &&
    current.canvasId === canvasId &&
    (current.arrangementStatus === 'ready' || current.arrangementStatus === 'empty')
  if (keepDraft) return true
  current.startSession({ projectId, projectName, sceneId, canvasId })
  return true
}

function recordWorkspaceFailure(projectId: string, failure: { code: number; msg: string }): void {
  const current = useWorkbenchSessionStore.getState()
  if (current.projectId !== '' && current.projectId !== projectId) return
  const holdingDraft =
    current.projectId === projectId &&
    (current.arrangementStatus === 'ready' || current.arrangementStatus === 'empty')
  if (holdingDraft) return
  current.setArrangementFailure(failure)
}

async function loadWorkspace(
  projectFilesClient: ProjectFilesClient,
  sceneCanvasClient: SceneCanvasClient,
  queryClient: QueryClient,
  projectId: string,
  options?: { preserveArrangementOnFailure?: boolean }
): Promise<boolean> {
  const [sources, arrangement] = await Promise.all([
    refreshSources(projectFilesClient, queryClient, projectId),
    loadArrangement(sceneCanvasClient, projectFilesClient, projectId, {
      preserveOnFailure: options?.preserveArrangementOnFailure === true
    })
  ])
  return sources && arrangement
}
export type WorkspaceRebuildPhase = 'rebuilding' | 'failed' | 'ready' | 'loaded'

/** 显式重新构建：核对工作区，成功后再读取画布。已有未保存编辑时不覆盖。 */
export async function rebuildOpenedWorkspace(
  projectClient: ProjectClient,
  projectFilesClient: ProjectFilesClient,
  sceneCanvasClient: SceneCanvasClient,
  queryClient: QueryClient,
  projectId: string,
  projectName: string,
  stillCurrent: () => boolean,
  onPhase: (phase: WorkspaceRebuildPhase) => void
): Promise<boolean> {
  onPhase('rebuilding')
  const ready = await ensureWorkspace(projectClient, projectId, projectName)
  if (!stillCurrent()) return false
  if (!ready) {
    onPhase('failed')
    return false
  }
  onPhase('ready')
  const state = useWorkbenchSessionStore.getState()
  if (
    state.projectId === projectId &&
    sessionIsDirty(state) &&
    (state.arrangementStatus === 'ready' || state.arrangementStatus === 'empty')
  ) {
    if (state.saveError?.code === PROJECT_WORKSPACE_NOT_READY_CODE) {
      useWorkbenchSessionStore.setState({ saveState: 'dirty', saveError: null })
    }
    onPhase('loaded')
    return true
  }
  const loaded = await loadWorkspace(projectFilesClient, sceneCanvasClient, queryClient, projectId)
  if (!stillCurrent()) return false
  if (!loaded) return false
  onPhase('loaded')
  return true
}

/** 重建进行中再次点击直接跳过，不发出第二次核对。 */
export function beginWorkspaceRebuild(lock: { current: boolean }): boolean {
  if (lock.current) return false
  lock.current = true
  return true
}

export async function refreshSources(
  client: ProjectFilesClient,
  queryClient: QueryClient,
  projectId: string
): Promise<boolean> {
  const store = useWorkbenchSessionStore.getState()
  try {
    const sources = await fetchProjectInputSources(client, queryClient, projectId)
    if (useWorkbenchSessionStore.getState().projectId !== projectId) return false
    store.setCatalog(sources)
    return true
  } catch (error) {
    if (useWorkbenchSessionStore.getState().projectId !== projectId) return false
    const failure = failureOf(error)
    if (isOwnershipMismatch(failure.code)) {
      store.setPageBlocked(true)
      toast(workbenchFeedback.ownershipBlocked)
    }
    const cached = queryClient.getQueryData<ProjectInputCatalogVO>(
      projectInputSourcesQueryKey(projectId)
    )
    if (cached) {
      store.setCatalog(cached.sources)
      store.setCatalogFailure(failure)
      return false
    }
    store.setCatalogFailure(failure)
    return false
  }
}

export async function loadArrangement(
  client: SceneCanvasClient,
  projectFilesClient: ProjectFilesClient,
  projectId: string,
  options?: { preserveOnFailure?: boolean }
): Promise<boolean> {
  const store = useWorkbenchSessionStore.getState()
  try {
    const arrangement = requireSuccess(
      await client.readSceneCanvasArrangement({
        projectId,
        sceneId: useWorkbenchSessionStore.getState().sceneId,
        canvasId: useWorkbenchSessionStore.getState().canvasId
      })
    )
    if (arrangement === null) {
      store.setArrangementEmpty()
      return true
    }
    const sourceIds = [
      ...new Set(
        arrangement.cards.flatMap((card) =>
          card.kind === 'document' ||
          card.kind === 'image' ||
          card.kind === 'audio' ||
          card.kind === 'video'
            ? [card.sourceId]
            : []
        )
      )
    ]
    if (sourceIds.length > 0) {
      try {
        const snapshot = requireSuccess(
          await projectFilesClient.readProjectInputSources({ projectId, sourceIds })
        )
        store.putSourceDetails(snapshot.sources)
      } catch {
        /* 详情失败仍展示编排卡片，来源状态由摘要判断。 */
      }
    }
    if (useWorkbenchSessionStore.getState().projectId !== projectId) return false
    const spacingMoves = resolveCardSpacing(arrangement.cards)
    const normalized =
      spacingMoves.length === 0
        ? arrangement
        : {
            ...arrangement,
            cards: arrangement.cards.map((card) => {
              const move = spacingMoves.find((item) => item.cardId === card.cardId)
              return move
                ? { ...card, layout: { ...card.layout, x: move.x, y: move.y } }
                : card
            })
          }
    const current = useWorkbenchSessionStore.getState()
    current.setArrangement(
      normalized,
      spacingMoves.length > 0 ? { baseline: arrangement } : undefined
    )
    if (spacingMoves.length > 0) {
      // 装载时自动保存器可能还没启动，这里只把本次间距调整落盘；
      // 失败保持 draft 与基线之间的 dirty，沿用自动保存的错误显示。
      const state = useWorkbenchSessionStore.getState()
      const sent = snapshotOf(state)
      const projectAtSave = state.projectId
      state.markSaving()
      try {
        requireSuccess(
          await client.saveSceneCanvasArrangement({
            projectId: projectAtSave,
            sceneId: state.sceneId,
            canvasId: state.canvasId,
            reason: 'periodic',
            arrangement: draftArrangementOf(state)
          })
        )
        if (useWorkbenchSessionStore.getState().projectId !== projectAtSave) return true
        useWorkbenchSessionStore.getState().markSaved(sent)
      } catch (error) {
        if (useWorkbenchSessionStore.getState().projectId !== projectAtSave) return true
        const failure = failureOf(error)
        const safe =
          failure.code === PROJECT_WORKSPACE_NOT_READY_CODE
            ? { code: failure.code, msg: '工程初始化未完成，请重新构建' }
            : failure
        const saveState = saveStateOfCode(safe.code)
        const latest = useWorkbenchSessionStore.getState()
        latest.markSaveFailure(saveState, safe)
        const referenceFailure = promptReferenceFailureOf(safe)
        if (referenceFailure) {
          latest.setPromptReferenceAlert({ message: referenceFailure.text })
        }
        toast(
          referenceFailure
            ? `${workbenchFeedback.saveFailed}（${referenceFailure.text}）`
            : saveFailureText(saveState, safe.msg)
        )
      }
    }
    return true
  } catch (error) {
    const current = useWorkbenchSessionStore.getState()
    if (current.projectId !== projectId) return false
    const failure = failureOf(error)
    if (
      isOwnershipMismatch(failure.code) ||
      failure.code === SCENE_CANVAS_OWNERSHIP_MISMATCH_CODE
    ) {
      current.setPageBlocked(true)
      toast(workbenchFeedback.ownershipBlocked)
      return false
    }
    const preserve =
      options?.preserveOnFailure === true &&
      current.baseline !== null &&
      (current.arrangementStatus === 'ready' || current.arrangementStatus === 'empty')
    if (!preserve) current.setArrangementFailure(failure)
    return false
  }
}

async function inspectProject(client: ProjectFilesClient, projectId: string): Promise<void> {
  try {
    const inspection = requireSuccess(await client.inspectProjectFiles({ projectId }))
    useWorkbenchSessionStore.getState().setInspectionDiagnostics(inspection.diagnostics)
    toast(
      inspection.diagnostics.length
        ? workbenchFeedback.inspectIssues(inspection.diagnostics.length)
        : workbenchFeedback.inspectDone
    )
  } catch (error) {
    toast(projectFilesFailureMessage(failureOf(error)))
  }
}
