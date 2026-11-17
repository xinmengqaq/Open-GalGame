import { useQuery } from '@tanstack/react-query'
import { clsx } from 'clsx'
import { Clapperboard, Package } from 'lucide-react'
import { useCallback, useMemo, useRef, useState, type ReactElement } from 'react'

import type { SceneGenerationRenderStatusVO } from '@application/scene-generation/vo/SceneGenerationRenderVO'
import type { ProjectClient } from '@interfaces/client/ProjectClient'
import type { ProjectFilesClient } from '@interfaces/project-files/client/ProjectFilesClient'
import type { ProjectVersioningClient } from '@interfaces/project-versioning/client/ProjectVersioningClient'
import type { SceneCanvasClient } from '@interfaces/scene-canvas/client/SceneCanvasClient'
import type { SceneExportClient } from '@interfaces/scene-export/client/SceneExportClient'
import type { SceneGenerationClient } from '@interfaces/scene-generation/client/SceneGenerationClient'
import type { ScenePreviewClient } from '@interfaces/scene-preview/client/ScenePreviewClient'
import type { SystemPathClient } from '@interfaces/system-path/client/SystemPathClient'
import { DocumentLayer } from '../../features/document-layer/DocumentLayer'
import { InputCatalogPanel } from '../../features/input-catalog/InputCatalogPanel'
import { ProjectMediaProvider } from '../../features/media-preview/ProjectMediaProvider'
import { SceneCanvas } from '../../features/scene-canvas/SceneCanvas'
import {
  createWorkbenchCommands,
  type WorkbenchCommands
} from '../../features/workbench-session/workbenchCommands'
import { WorkbenchCommandsProvider } from '../../features/workbench-session/workbenchCommandsProvider'
import { WorkbenchStateBanner } from '../../features/workbench-session/WorkbenchStateBanner'
import { promptReferenceFailureOf } from '../../features/workbench-session/promptReferences'
import { saveStatusOf } from '../../features/workbench-session/workbenchSaveStatus'
import {
  sessionIsDirty,
  useWorkbenchSessionStore
} from '../../features/workbench-session/workbenchSession.store'
import { useShallow } from 'zustand/react/shallow'

import { requireSuccess } from '../../feedback/failure'
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
  generationPhaseOf,
  isTerminalState
} from './drawer/generation/generationPresentation'
import { useSceneGeneration, type SaveCanvasOutcome } from './drawer/generation/useSceneGeneration'
import { useWorkbenchDrawerController } from './drawer/useWorkbenchDrawerController'
import type { DrawerTabTone } from './drawer/workbenchDrawer.types'
import { historyFeedback } from './drawer/version-history/versionHistoryPresentation'
import { SparkleMark } from './drawer/drawerIcons'
import { HistoryIcon, InspectIcon, RefreshIcon, SaveIcon } from './WorkbenchIcons'
import { FeedbackLayer } from './shell/FeedbackLayer'
import { SceneExportStatus } from './shell/SceneExportStatus'
import { openExportDirectory } from './shell/sceneTaskPresentation'
import { useWorkbenchExportController } from './shell/useWorkbenchExportController'
import { useWorkbenchHistoryRecovery } from './shell/useWorkbenchHistoryRecovery'
import { VersionHistoryRecoveryBar } from './shell/VersionHistoryRecoveryBar'
import { WorkbenchToolbar } from './shell/WorkbenchToolbar'
import type { WorkbenchToolbarAction } from './shell/workbenchActions'
import { WorkbenchPreviewLayer } from './shell/WorkbenchPreviewLayer'
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
  systemPathClient: SystemPathClient
}

export function WorkbenchPage({
  projectClient,
  projectFilesClient,
  sceneCanvasClient,
  projectVersioningClient,
  sceneGenerationClient,
  scenePreviewClient,
  sceneExportClient,
  systemPathClient
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
        systemPathClient={systemPathClient}
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
  systemPathClient,
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
      ? promptReferenceFailureOf(state.saveError)
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
  const candidateAvailable = candidateTarget !== null
  const candidateSnapshotId = candidateTarget?.candidateSnapshotId ?? null
  const statusSequence = generation.status?.sequence ?? null
  const drawer = useWorkbenchDrawerController({
    scopeKey: `${projectId}|${sceneId}`,
    candidate: {
      available: candidateAvailable,
      snapshotId: candidateSnapshotId,
      sequence: statusSequence
    },
    generationActive,
    onReloadGeneration: generation.reload
  })
  const currentTone = drawerToneOf(generation.status)
  const [noticeSlot, setNoticeSlot] = useState<HTMLElement | null>(null)
  const [previewOpen, setPreviewOpen] = useState(false)
  const [previewReturnFocus, setPreviewReturnFocus] = useState<HTMLElement | null>(null)
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

  const refreshPreviewAvailability = useCallback((): void => {
    void previewAvailability.refetch()
  }, [previewAvailability.refetch])

  const history = useWorkbenchHistoryRecovery({
    commands,
    opened,
    reloadAfterHistoryUndo: page.reloadAfterHistoryUndo,
    hasUnsavedEdits,
    saveState: saveStatus.state,
    pageBlocked,
    generationActive
  })

  const exportController = useWorkbenchExportController({
    sceneExportClient,
    scope: { opened, projectId, sceneId },
    entry: {
      pageBlocked,
      workspaceBlocked,
      generationActive,
      viewStale: history.viewStale,
      saveState: saveStatus.state,
      saveLabel: saveStatus.label
    },
    commands,
    refreshPreviewAvailability,
    generationSettled: {
      succeeded: generation.status?.state === 'succeeded',
      commitId: generation.status?.result?.commitId ?? null
    }
  })
  const closeDrawerForPreview = drawer.actions.closeForPreview
  const openPreview = useCallback((): void => {
    if (!previewCanOpen) return
    setPreviewReturnFocus(
      document.activeElement instanceof HTMLElement ? document.activeElement : null
    )
    closeDrawerForPreview()
    setPreviewOpen(true)
  }, [closeDrawerForPreview, previewCanOpen])

  const toolbarActions: readonly WorkbenchToolbarAction[] = [
    {
      id: 'generate',
      label: '生成',
      icon: <SparkleMark />,
      disabled: !opened || pageBlocked || loading || workspaceBlocked,
      hint: generationActive ? '回到当前生成任务' : '打开生成面板，开始生成本场景',
      onInvoke: drawer.actions.openGeneration
    },
    {
      id: 'history',
      label: '历史记录',
      icon: <HistoryIcon />,
      disabled: !opened || pageBlocked || workspaceBlocked,
      hint: '打开保存历史、撤销与清理入口',
      onInvoke: drawer.actions.openWorks
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
      label: exportController.exporting ? '正在导出' : '导出',
      icon: <Package size={17} strokeWidth={1.75} />,
      disabled: !exportController.entry.canRun,
      hint: exportController.entry.hint,
      iconOnly: true,
      onInvoke: () => void exportController.runExport()
    },
    {
      id: 'save',
      label: saving ? '正在保存…' : workbenchFeedback.saveAction,
      icon: <SaveIcon />,
      disabled:
        saving || pageBlocked || history.viewStale || generationActive || workspaceBlocked,
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
              notice={exportController.notice}
              onDismiss={exportController.dismissNotice}
              onOpenDirectory={(directoryPath) =>
                openExportDirectory(systemPathClient, directoryPath)
              }
            />
          }
          registerInset={layout.registerInset}
          onBack={() => visit('projects')}
        />

        <FeedbackLayer
          active={history.viewStale || history.draft.snapshot !== null}
          topOffset={layout.insets.topBar}
          onNoticeSlotChange={setNoticeSlot}
        >
          {history.viewStale ? (
            <div className={styles.staleBar} role="status">
              <span className={styles.staleSpinner} aria-hidden="true" />
              <p>{historyFeedback.staleTitle}</p>
            </div>
          ) : null}
          <VersionHistoryRecoveryBar
            draft={history.draft.snapshot}
            canRestore={history.draft.canRestore}
            blockedReason={history.draft.blockedReason}
            onRestore={history.draft.restore}
            onDiscard={history.draft.discard}
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
              {drawer.generationLockVisible ? (
                <div className={styles.generationLock} role="status">
                  <div className={styles.generationLockPanel}>
                    <span aria-hidden="true" className={styles.generationLockOrb}>
                      <SparkleMark />
                    </span>
                    <p>
                      <strong>生成进行中</strong>
                      画布暂时只读，避免生成读取到一半的编排。
                    </p>
                    <button onClick={drawer.actions.openGeneration} type="button">
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
            returnFocusTo={previewReturnFocus}
            onExit={() => setPreviewOpen(false)}
            onSavedVersion={exportController.acceptSavedVersion}
          />
        ) : null}
        {opened ? (
          <WorkbenchDrawer
            captureDraft={history.captureDraft}
            candidatePreviewClient={scenePreviewClient}
            candidateTarget={candidateTarget}
            currentTone={currentTone}
            currentView={
              <GenerationPanel
                cards={cards}
                controller={generation}
                exportDisabled={!exportController.entry.canRun}
                exportHint={exportController.entry.hint}
                exporting={exportController.exporting}
                onExport={() => void exportController.runExport()}
                onOpenHistory={() => drawer.actions.openTab('history')}
                onOpenSummary={() => drawer.actions.openTab('summary')}
                onOpenWorks={() => drawer.actions.openTab('works')}
                onReturnToCanvas={() => drawer.onOpenChange(false)}
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
                onOpenRun={() => drawer.actions.openTab('current')}
                projectId={projectId}
                refreshKey={historyRefreshKey}
                sceneId={sceneId}
              />
            }
            onActivateTab={drawer.actions.activateTab}
            onCloseTab={drawer.actions.closeTab}
            onMoveTab={drawer.actions.moveTab}
            onOpenChange={drawer.onOpenChange}
            onOpenTab={drawer.actions.openTab}
            onUndoCommitted={history.onUndoCommitted}
            onWorksBusyChange={drawer.setWorksBusy}
            open={drawer.open}
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
            tabs={drawer.tabs}
            versioningClient={projectVersioningClient}
            worksBusy={drawer.worksBusy}
            writeBlockedReason={history.writeBlockedReason}
          />
        ) : null}
      </section>
    </ProjectMediaProvider>
  )
}
