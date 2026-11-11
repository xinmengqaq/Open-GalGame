import { useQuery } from '@tanstack/react-query'
import { clsx } from 'clsx'
import { Clapperboard, Package } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react'

import type { SceneGenerationRenderStatusVO } from '@application/scene-generation/vo/SceneGenerationRenderVO'
import type { ProjectClient } from '@interfaces/client/ProjectClient'
import type { ProjectFilesClient } from '@interfaces/project-files/client/ProjectFilesClient'
import type { ProjectVersioningClient } from '@interfaces/project-versioning/client/ProjectVersioningClient'
import type { SceneCanvasClient } from '@interfaces/scene-canvas/client/SceneCanvasClient'
import type { SceneExportClient } from '@interfaces/scene-export/client/SceneExportClient'
import type { SceneGenerationClient } from '@interfaces/scene-generation/client/SceneGenerationClient'
import type { ScenePreviewClient } from '@interfaces/scene-preview/client/ScenePreviewClient'
import { DocumentLayer } from '../../features/document-layer/DocumentLayer'
import { InputCatalogPanel } from '../../features/input-catalog/InputCatalogPanel'
import { ProjectMediaProvider } from '../../features/media-preview/ProjectMediaProvider'
import { SceneCanvas } from '../../features/scene-canvas/SceneCanvas'
import {
  createWorkbenchCommands,
  type WorkbenchCommands
} from '../../features/workbench-session/workbenchCommands'
import { WorkbenchCommandsProvider } from '../../features/workbench-session/workbenchCommandsContext'
import { WorkbenchStateBanner } from '../../features/workbench-session/WorkbenchStateBanner'
import { promptReferenceFailureOf } from '../../features/workbench-session/promptReferences'
import { saveStatusOf } from '../../features/workbench-session/workbenchSaveStatus'
import {
  sessionIsDirty,
  useWorkbenchSessionStore
} from '../../features/workbench-session/workbenchSession.store'
import { snapshotOf } from '../../features/workbench-session/workbenchSessionMapper'
import type { SessionSnapshot } from '../../features/workbench-session/workbenchSession.types'
import { useShallow } from 'zustand/react/shallow'

import { failureOf, requireSuccess } from '../../feedback/failure'
import {
  PROJECT_WORKSPACE_NOT_READY_CODE,
  workbenchFeedback
} from '../../feedback/workbenchFeedback'
import { useNavigationStore } from '../../stores/navigation.store'
import { WorkbenchDrawer } from './drawer/WorkbenchDrawer'
import { candidatePreviewTargetOf } from './drawer/candidate/candidatePreviewState'
import { GenerationPanel } from './drawer/generation/GenerationPanel'
import { GenerationHistory } from './drawer/generation/GenerationHistory'
import { GenerationInputSummaryView } from './drawer/generation/GenerationInputSummary'
import {
  generationHistoryBlockedReason,
  generationPhaseOf,
  isTerminalState
} from './drawer/generation/generationPresentation'
import { useSceneGeneration, type SaveCanvasOutcome } from './drawer/generation/useSceneGeneration'
import { useDrawerTabs } from './drawer/useDrawerTabs'
import type { DrawerTabTone, WorkbenchDrawerBusy } from './drawer/workbenchDrawer.types'
import {
  historyFeedback,
  undoBlockedReason
} from './drawer/version-history/versionHistoryPresentation'
import { SparkleMark } from './drawer/drawerIcons'
import { HistoryIcon, InspectIcon, RefreshIcon, SaveIcon } from './WorkbenchIcons'
import { FeedbackLayer } from './shell/FeedbackLayer'
import { SceneExportStatus, type SceneExportNotice } from './shell/SceneExportStatus'
import {
  latestPreviewSaveOfResult,
  savedSceneVersionOfPreviewSave,
  sceneExportEntryOf
} from './shell/sceneExportEntry'
import { exportNoticeOf, exportRequestOf, openExportDirectory } from './shell/sceneTaskPresentation'
import { VersionHistoryRecoveryBar } from './shell/VersionHistoryRecoveryBar'
import { WorkbenchToolbar } from './shell/WorkbenchToolbar'
import type { WorkbenchToolbarAction } from './shell/workbenchActions'
import { WorkbenchPreviewLayer, type SavedSceneVersionFact } from './shell/WorkbenchPreviewLayer'
import { useMeasuredWidth, useWorkbenchLayoutInsets } from './shell/workbenchLayout'
import { useWorkbenchMotion } from './useWorkbenchMotion'
import { WorkspaceNotReadyPanel } from './WorkspaceNotReadyPanel'
import { useWorkbenchPage } from './useWorkbenchPage'
import theme from './workbenchTheme.module.css'
import styles from './WorkbenchPage.module.css'

const COMPACT_ACTIONS_WIDTH = 1180

/** “当前生成”标签只用真实任务阶段表达进行中 / 等待 / 暂停 / 失败 / 待核对。 */
function drawerToneOf(status: SceneGenerationRenderStatusVO | null): DrawerTabTone | null {
  if (status === null) return null
  /* 提交结果不明是等待核对，不是失败；标签点不能沿用失败语义。 */
  if (status.failure?.unverified === true) return 'pendingVerification'
  switch (generationPhaseOf(status)) {
    case 'failed':
      return 'failed'
    case 'paused':
      return 'paused'
    case 'waiting':
      return 'waiting'
    case 'preparing':
    case 'running':
    case 'committing':
    case 'cancelling':
      return 'running'
    default:
      return null
  }
}

interface WorkbenchPageProps {
  projectClient: ProjectClient
  projectFilesClient: ProjectFilesClient
  sceneCanvasClient: SceneCanvasClient
  projectVersioningClient: ProjectVersioningClient
  sceneGenerationClient: SceneGenerationClient
  scenePreviewClient: ScenePreviewClient
  sceneExportClient: SceneExportClient
}

export function WorkbenchPage({
  projectClient,
  projectFilesClient,
  sceneCanvasClient,
  projectVersioningClient,
  sceneGenerationClient,
  scenePreviewClient,
  sceneExportClient
}: WorkbenchPageProps): ReactElement {
  const commands = useMemo(() => createWorkbenchCommands(sceneCanvasClient), [sceneCanvasClient])
  return (
    <WorkbenchCommandsProvider commands={commands}>
      <WorkbenchScreen
        projectClient={projectClient}
        projectFilesClient={projectFilesClient}
        sceneCanvasClient={sceneCanvasClient}
        projectVersioningClient={projectVersioningClient}
        sceneGenerationClient={sceneGenerationClient}
        scenePreviewClient={scenePreviewClient}
        sceneExportClient={sceneExportClient}
        commands={commands}
      />
    </WorkbenchCommandsProvider>
  )
}

function WorkbenchScreen({
  projectClient,
  projectFilesClient,
  sceneCanvasClient,
  projectVersioningClient,
  sceneGenerationClient,
  scenePreviewClient,
  sceneExportClient,
  commands
}: WorkbenchPageProps & {
  commands: WorkbenchCommands
}): ReactElement {
  const visit = useNavigationStore((state) => state.visit)
  const opened = useNavigationStore((state) => state.openedProject)
  const page = useWorkbenchPage(projectClient, projectFilesClient, sceneCanvasClient, commands)
  const root = useRef<HTMLElement>(null)
  useWorkbenchMotion(root)
  const layout = useWorkbenchLayoutInsets()
  const shellWidth = useMeasuredWidth(root)
  const projectName = useWorkbenchSessionStore((state) => state.projectName)
  const sceneLabel = useWorkbenchSessionStore((state) => state.sceneLabel)
  const arrangementStatus = useWorkbenchSessionStore((state) => state.arrangementStatus)
  const arrangementError = useWorkbenchSessionStore((state) => state.arrangementError)
  const saveError = useWorkbenchSessionStore((state) => state.saveError)
  const pageBlocked = useWorkbenchSessionStore((state) => state.pageBlocked)
  const projectId = useWorkbenchSessionStore((state) => state.projectId)
  const sceneId = useWorkbenchSessionStore((state) => state.sceneId)
  const canvasId = useWorkbenchSessionStore((state) => state.canvasId)
  const cards = useWorkbenchSessionStore((state) => state.cards)
  const saveStatus = useWorkbenchSessionStore(useShallow(saveStatusOf))
  const hasUnsavedEdits = useWorkbenchSessionStore((state) => sessionIsDirty(state))
  const saveCanvasForGeneration = useCallback(async (): Promise<SaveCanvasOutcome> => {
    await commands.save('beforeGeneration')
    const state = useWorkbenchSessionStore.getState()
    if (state.projectId !== projectId) return { ok: false, message: '工程已切换，生成没有开始。' }
    if (state.saveState === 'saved' || state.saveState === 'idle') return { ok: true }
    const referenceFailure = state.saveError
      ? promptReferenceFailureOf({
          code: state.saveError.code,
          message: state.saveError.msg
        })
      : null
    return {
      ok: false,
      message:
        referenceFailure?.text ?? state.saveError?.msg ?? '画布没有保存成功，暂时不能开始生成。'
    }
  }, [commands, projectId])
  const generation = useSceneGeneration({
    projectClient,
    client: sceneGenerationClient,
    projectId,
    sceneId,
    canvasId,
    saveState: saveStatus.state,
    pageBlocked,
    canvasReady: arrangementStatus === 'ready' || arrangementStatus === 'empty',
    saveCanvas: saveCanvasForGeneration
  })
  const generationActive = generation.status !== null && !isTerminalState(generation.status.state)
  const candidateTarget = candidatePreviewTargetOf(generation.status)
  const historyRefreshKey =
    generation.status !== null && isTerminalState(generation.status.state)
      ? `${generation.status.operationId}:${generation.status.state}:${generation.status.stage}`
      : ''
  const [drawerOpen, setDrawerOpen] = useState(false)
  const drawerTabs = useDrawerTabs(`${projectId}|${sceneId}`)
  const [worksBusy, setWorksBusy] = useState<WorkbenchDrawerBusy>(null)
  const drawerTrigger = useRef<HTMLElement | null>(null)
  const candidateAvailable = candidateTarget !== null
  const candidateSnapshotId = candidateTarget?.candidateSnapshotId ?? null
  const statusSequence = generation.status?.sequence ?? null
  const syncCandidate = drawerTabs.syncCandidate
  /* 每次生成状态更新都报告候选可用性；新范围第一份报告只建基线。 */
  useEffect(() => {
    syncCandidate(candidateAvailable, candidateSnapshotId)
  }, [candidateAvailable, candidateSnapshotId, statusSequence, syncCandidate])
  const currentTone = drawerToneOf(generation.status)
  const [recoveryDraft, setRecoveryDraft] = useState<SessionSnapshot | null>(null)
  const [viewStale, setViewStale] = useState(false)
  const [retryNonce, setRetryNonce] = useState(0)
  const [noticeSlot, setNoticeSlot] = useState<HTMLElement | null>(null)
  const [previewOpen, setPreviewOpen] = useState(false)
  const previewReturnFocus = useRef<HTMLElement | null>(null)
  const [savedSceneVersion, setSavedSceneVersion] = useState<SavedSceneVersionFact | null>(null)
  const [exportNotice, setExportNotice] = useState<SceneExportNotice | null>(null)
  const [exporting, setExporting] = useState(false)
  const exportingRef = useRef(false)
  const exportRun = useRef(0)
  const hydrationRun = useRef(0)
  const previewSavedDuringHydration = useRef(false)
  const name = projectName || opened?.name || '未打开工程'
  const loading = arrangementStatus === 'loading' || arrangementStatus === 'idle'
  const workspaceBlocked =
    page.workspaceNotReady ||
    arrangementError?.code === PROJECT_WORKSPACE_NOT_READY_CODE ||
    saveError?.code === PROJECT_WORKSPACE_NOT_READY_CODE
  const saving = saveStatus.state === 'saving'
  const compactActions = shellWidth < COMPACT_ACTIONS_WIDTH

  const previewAvailability = useQuery({
    queryKey: ['workbench-scene-preview-availability', projectId, sceneId],
    queryFn: async () =>
      requireSuccess(await scenePreviewClient.readPreviewAvailability({ projectId, sceneId })),
    enabled:
      opened !== null &&
      projectId.length > 0 &&
      sceneId.length > 0 &&
      !pageBlocked &&
      !workspaceBlocked
  })
  const availability = previewAvailability.data
  const previewChecking = previewAvailability.isFetching && availability === undefined
  const previewCanOpen =
    availability?.status === 'available' &&
    !previewAvailability.isError &&
    !pageBlocked &&
    !workspaceBlocked
  const previewHint = previewChecking
    ? '正在检查当前场景内容…'
    : previewAvailability.isError
      ? '暂时无法确认当前场景内容，不能打开试玩预览'
      : availability?.status === 'blocked'
        ? availability.message
        : !previewCanOpen
          ? '工作台还没准备好，暂不能试玩预览'
          : '打开当前场景的真实 WebGAL 试玩预览'

  const exportEntry = sceneExportEntryOf({
    savedSceneVersion,
    exporting,
    pageBlocked,
    workspaceBlocked,
    generationActive,
    viewStale,
    saveState: saveStatus.state,
    saveLabel: saveStatus.label
  })
  const exportCanRun = exportEntry.canRun
  const exportHint = exportEntry.hint

  useEffect(() => {
    if (generation.status?.state !== 'succeeded') return
    setSavedSceneVersion(null)
    setExportNotice(null)
    void previewAvailability.refetch()
  }, [generation.status?.state, generation.status?.result?.commitId, previewAvailability.refetch])

  useEffect(() => {
    if (exportNotice?.tone !== 'ok' || exportNotice.directoryPath) return
    const timer = setTimeout(() => setExportNotice(null), 5000)
    return () => clearTimeout(timer)
  }, [exportNotice])

  /* 重载或切换场景后从后端恢复导出前置：只采用已结算的预览保存，不伪造版本。 */
  useEffect(() => {
    if (opened === null || projectId.length === 0 || sceneId.length === 0) {
      setSavedSceneVersion(null)
      return
    }
    const run = ++hydrationRun.current
    previewSavedDuringHydration.current = false
    setSavedSceneVersion(null)
    void (async (): Promise<void> => {
      try {
        const result = await sceneExportClient.readLatestPreviewSave({ projectId, sceneId })
        if (run !== hydrationRun.current || previewSavedDuringHydration.current) return
        setSavedSceneVersion(savedSceneVersionOfPreviewSave(latestPreviewSaveOfResult(result)))
      } catch {
        if (run !== hydrationRun.current || previewSavedDuringHydration.current) return
        setSavedSceneVersion(null)
      }
    })()
    return () => {
      if (run === hydrationRun.current) hydrationRun.current += 1
    }
  }, [opened, projectId, sceneId, sceneExportClient])

  useEffect(
    () => () => {
      exportRun.current += 1
    },
    []
  )
  const writeBlockedReason = viewStale
    ? historyFeedback.blockedStale
    : (undoBlockedReason({
        saveState: saveStatus.state,
        pageBlocked
      }) ?? (generationActive ? generationHistoryBlockedReason : null))
  const canRestoreDraft = recoveryDraft !== null && !hasUnsavedEdits && !viewStale
  const restoreBlockedReason =
    recoveryDraft === null
      ? null
      : viewStale
        ? historyFeedback.restoreBlockedStale
        : hasUnsavedEdits
          ? historyFeedback.restoreBlockedDirty
          : null

  const reloadGeneration = generation.reload
  const handleDrawerOpenChange = useCallback(
    (next: boolean) => {
      setDrawerOpen(next)
      if (next) {
        reloadGeneration()
        return
      }
      const trigger = drawerTrigger.current
      drawerTrigger.current = null
      if (trigger) window.setTimeout(() => trigger.focus({ preventScroll: true }), 0)
    },
    [reloadGeneration]
  )

  const captureDraft = useCallback(async () => {
    if (!opened) return null
    await commands.prepareHistoryWrite()
    const state = useWorkbenchSessionStore.getState()
    if (state.projectId !== opened.id) return null
    return sessionIsDirty(state) ? snapshotOf(state) : null
  }, [commands, opened])

  const onUndoCommitted = useCallback(
    async (draft: SessionSnapshot | null) => {
      if (!opened) return
      if (draft) setRecoveryDraft(draft)
      setRetryNonce(0)
      setViewStale(true)
      commands.setSaveHold(true)
    },
    [commands, opened]
  )

  const retryHistoryReload = useCallback(async () => {
    if (!opened) return
    const projectId = opened.id
    try {
      const reloaded = await page.reloadAfterHistoryUndo()
      if (useWorkbenchSessionStore.getState().projectId !== projectId) return
      if (reloaded) {
        setViewStale(false)
        commands.setSaveHold(false)
        return
      }
    } catch {}
    if (useWorkbenchSessionStore.getState().projectId !== projectId) return
    setRetryNonce((count) => count + 1)
  }, [commands, opened, page])

  useEffect(() => {
    if (!viewStale) return
    const delay = retryNonce === 0 ? 0 : Math.min(1200 * 2 ** Math.min(retryNonce - 1, 3), 8000)
    const timer = setTimeout(() => void retryHistoryReload(), delay)
    return () => clearTimeout(timer)
  }, [retryHistoryReload, retryNonce, viewStale])

  const restoreDraft = useCallback(() => {
    if (!recoveryDraft || restoreBlockedReason) return
    useWorkbenchSessionStore.getState().restoreSessionDraft(recoveryDraft)
    setRecoveryDraft(null)
  }, [recoveryDraft, restoreBlockedReason])

  const openGeneration = (): void => {
    drawerTrigger.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null
    drawerTabs.open('current')
    setDrawerOpen(true)
    reloadGeneration()
  }

  const openPreview = useCallback((): void => {
    if (!previewCanOpen) return
    drawerTrigger.current = null
    previewReturnFocus.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null
    setDrawerOpen(false)
    setPreviewOpen(true)
  }, [previewCanOpen])

  const handleSavedSceneVersion = useCallback((saved: SavedSceneVersionFact): void => {
    if (saved.requestId.trim() === '' || saved.contentBasis.digest.trim() === '') return
    previewSavedDuringHydration.current = true
    setSavedSceneVersion(saved)
    setExportNotice(null)
  }, [])

  const handleOpenDirectory = useCallback(
    async (directoryPath: string): Promise<void> => {
      await openExportDirectory(sceneExportClient, directoryPath)
    },
    [sceneExportClient]
  )

  const handleExport = useCallback(async (): Promise<void> => {
    const version = savedSceneVersion
    if (!version || exportingRef.current || !exportCanRun) return
    exportingRef.current = true
    const run = ++exportRun.current
    setExporting(true)
    setExportNotice({
      tone: 'busy',
      label: '导出中',
      detail: '正在保存工作台改动并打包当前场景。'
    })
    try {
      let state = useWorkbenchSessionStore.getState()
      if (state.projectId !== projectId) return
      if (sessionIsDirty(state)) {
        await commands.save('manual')
        state = useWorkbenchSessionStore.getState()
        if (run !== exportRun.current || state.projectId !== projectId) return
        if (sessionIsDirty(state) || (state.saveState !== 'saved' && state.saveState !== 'idle')) {
          setExportNotice({
            tone: 'danger',
            label: '导出已停止',
            detail: state.saveError?.msg ?? '工作台改动没有保存成功，导出已停止。'
          })
          return
        }
      }
      const result = requireSuccess(
        await sceneExportClient.exportSavedScene(exportRequestOf(projectId, sceneId, version))
      )
      if (run !== exportRun.current) return
      setExportNotice(exportNoticeOf(result))
    } catch (error) {
      if (run !== exportRun.current) return
      const failure = failureOf(error)
      setExportNotice({ tone: 'danger', label: '导出失败', detail: failure.msg })
    } finally {
      exportingRef.current = false
      if (run === exportRun.current) setExporting(false)
    }
  }, [commands, exportCanRun, projectId, savedSceneVersion, sceneExportClient, sceneId])

  const toolbarActions: readonly WorkbenchToolbarAction[] = [
    {
      id: 'generate',
      label: '生成',
      icon: <SparkleMark />,
      disabled: !opened || pageBlocked || loading || workspaceBlocked,
      hint: generationActive ? '回到当前生成任务' : '打开生成面板，开始生成本场景',
      onInvoke: openGeneration
    },
    {
      id: 'history',
      label: '历史记录',
      icon: <HistoryIcon />,
      disabled: !opened || pageBlocked || workspaceBlocked,
      hint: '打开保存历史、撤销与清理入口',
      onInvoke: () => {
        drawerTrigger.current =
          document.activeElement instanceof HTMLElement ? document.activeElement : null
        drawerTabs.open('works')
        setDrawerOpen(true)
      }
    },
    {
      id: 'inspect',
      label: '检查工程',
      icon: <InspectIcon />,
      hint: '检查工程文件与引用完整性',
      onInvoke: () => void page.inspectProject()
    },
    {
      id: 'refresh',
      label: '刷新来源',
      icon: <RefreshIcon />,
      hint: '重新读取输入来源目录',
      onInvoke: () => void page.refreshSources()
    },
    {
      id: 'preview',
      label: '试玩预览',
      icon: <Clapperboard size={17} strokeWidth={1.75} />,
      disabled: !previewCanOpen,
      hint: previewHint,
      iconOnly: true,
      onInvoke: openPreview
    },
    {
      id: 'export',
      label: exporting ? '正在导出' : '导出',
      icon: <Package size={17} strokeWidth={1.75} />,
      disabled: !exportCanRun,
      hint: exportHint,
      iconOnly: true,
      onInvoke: () => void handleExport()
    },
    {
      id: 'save',
      label: saving ? '正在保存…' : workbenchFeedback.saveAction,
      icon: <SaveIcon />,
      disabled: saving || pageBlocked || viewStale || generationActive || workspaceBlocked,
      hint: generationActive ? '生成进行中，保存已暂停' : (saveStatus.detail ?? saveStatus.label),
      onInvoke: () => void commands.save('manual')
    }
  ]

  return (
    <ProjectMediaProvider client={projectFilesClient} projectId={projectId}>
      <section
        ref={root}
        className={clsx(styles.screen, theme.theme)}
        aria-label="工作区"
        data-testid="workbench-screen"
      >
        <h1 className={styles.visuallyHidden}>工作区</h1>
        <div className={styles.wash} aria-hidden="true" />

        <WorkbenchToolbar
          projectName={name}
          sceneLabel={sceneLabel}
          statusSlot={
            pageBlocked ? (
              <span
                className={styles.blockedRead}
                role="status"
                title="当前工程文件不属于此工作台，已停止读取"
              >
                无法读取
              </span>
            ) : workspaceBlocked ? (
              <span className={clsx(styles.blockedRead, styles.workspaceRead)} role="status">
                工程还没准备好
              </span>
            ) : (
              <WorkbenchStateBanner />
            )
          }
          actions={toolbarActions}
          compact={compactActions}
          saveStatus={saveStatus}
          taskStatus={
            <SceneExportStatus
              notice={exportNotice}
              onDismiss={() => setExportNotice(null)}
              onOpenDirectory={handleOpenDirectory}
            />
          }
          registerInset={layout.registerInset}
          onBack={() => visit('projects')}
        />

        <FeedbackLayer
          active={viewStale || recoveryDraft !== null}
          topOffset={layout.insets.topBar}
          onNoticeSlotChange={setNoticeSlot}
        >
          {viewStale ? (
            <div className={styles.staleBar} role="status">
              <span className={styles.staleSpinner} aria-hidden="true" />
              <p>{historyFeedback.staleTitle}</p>
            </div>
          ) : null}
          <VersionHistoryRecoveryBar
            draft={recoveryDraft}
            canRestore={canRestoreDraft}
            blockedReason={restoreBlockedReason}
            onRestore={restoreDraft}
            onDiscard={() => setRecoveryDraft(null)}
          />
        </FeedbackLayer>

        {pageBlocked ? (
          <div className={styles.blocked}>
            <span className={styles.blockedOrb} aria-hidden="true">
              <svg viewBox="0 0 48 48">
                <path d="M14 8h13l8 8v24H14Z" />
                <path d="M27 8v8h8" />
                <path d="m19 22 9 9M28 22l-9 9" />
              </svg>
            </span>
            <p>{workbenchFeedback.ownershipBlocked}</p>
          </div>
        ) : workspaceBlocked ? (
          <div className={styles.body}>
            <aside className={styles.catalog} data-motion="panel">
              <InputCatalogPanel
                client={projectFilesClient}
                onRefresh={() => void page.refreshSources()}
              />
            </aside>
            <div className={styles.canvasArea} data-motion="stage">
              <WorkspaceNotReadyPanel
                failed={page.workspaceRebuildFailed}
                rebuilding={page.workspaceRebuilding}
                onRebuild={() => void page.rebuildWorkspace()}
              />
            </div>
          </div>
        ) : (
          <div className={styles.body}>
            <aside className={styles.catalog} data-motion="panel">
              <InputCatalogPanel
                client={projectFilesClient}
                onRefresh={() => void page.refreshSources()}
              />
            </aside>
            <div className={styles.canvasArea} data-motion="stage">
              {loading ? (
                <div className={styles.canvasLoading}>
                  <span className={styles.loadingMark} aria-hidden="true" />
                  <p>正在读取画布编排</p>
                </div>
              ) : (
                <SceneCanvas
                  client={projectFilesClient}
                  layoutInsets={layout.insets}
                  registerInset={layout.registerInset}
                  noticeSlot={noticeSlot}
                  onInspect={() => void page.inspectProject()}
                  onReload={() => void page.loadWorkspace()}
                />
              )}
              {generationActive && !drawerOpen ? (
                <div className={styles.generationLock} role="status">
                  <div className={styles.generationLockPanel}>
                    <span aria-hidden="true" className={styles.generationLockOrb}>
                      <SparkleMark />
                    </span>
                    <p>
                      <strong>生成进行中</strong>
                      画布暂时只读，避免生成读取到一半的编排。
                    </p>
                    <button onClick={openGeneration} type="button">
                      查看生成进度
                    </button>
                  </div>
                </div>
              ) : null}
            </div>
          </div>
        )}
        <DocumentLayer client={projectFilesClient} />
        {previewOpen && opened ? (
          <WorkbenchPreviewLayer
            client={scenePreviewClient}
            projectId={projectId}
            sceneId={sceneId}
            projectName={name}
            sceneLabel={sceneLabel}
            returnFocusTo={previewReturnFocus.current}
            onExit={() => setPreviewOpen(false)}
            onSavedVersion={handleSavedSceneVersion}
          />
        ) : null}
        {opened ? (
          <WorkbenchDrawer
            captureDraft={captureDraft}
            candidatePreviewClient={scenePreviewClient}
            candidateTarget={candidateTarget}
            currentTone={currentTone}
            currentView={
              <GenerationPanel
                cards={cards}
                controller={generation}
                exportDisabled={!exportCanRun}
                exportHint={exportHint}
                exporting={exporting}
                onExport={() => void handleExport()}
                onOpenHistory={() => drawerTabs.open('history')}
                onOpenSummary={() => drawerTabs.open('summary')}
                onOpenWorks={() => drawerTabs.open('works')}
                onReturnToCanvas={() => handleDrawerOpenChange(false)}
                projectName={name}
                sceneLabel={sceneLabel}
              />
            }
            generationClient={sceneGenerationClient}
            hasUnsavedEdits={hasUnsavedEdits}
            historyView={
              <GenerationHistory
                activeStatus={generation.status}
                cancelBusy={generation.pending === 'cancel'}
                canCancel={generation.status?.canCancel ?? false}
                client={sceneGenerationClient}
                key={`${projectId}|${sceneId}`}
                onCancel={() => void generation.cancel()}
                onOpenRun={() => drawerTabs.open('current')}
                projectId={projectId}
                refreshKey={historyRefreshKey}
                sceneId={sceneId}
              />
            }
            onActivateTab={drawerTabs.activate}
            onCloseTab={drawerTabs.close}
            onMoveTab={drawerTabs.move}
            onOpenChange={handleDrawerOpenChange}
            onOpenTab={drawerTabs.open}
            onUndoCommitted={onUndoCommitted}
            onWorksBusyChange={setWorksBusy}
            open={drawerOpen}
            projectId={opened.id}
            projectName={name}
            summaryView={
              <GenerationInputSummaryView
                cards={cards}
                loadError={arrangementError?.msg ?? null}
                loading={loading}
                status={generation.status}
              />
            }
            tabs={drawerTabs.state}
            versioningClient={projectVersioningClient}
            worksBusy={worksBusy}
            writeBlockedReason={writeBlockedReason}
          />
        ) : null}
      </section>
    </ProjectMediaProvider>
  )
}
