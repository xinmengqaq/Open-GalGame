import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'

import type { SceneExportDestinationDTO } from '@application/scene-export/dto/ExportSavedSceneDTO'
import type { SceneExportClient } from '@interfaces/scene-export/client/SceneExportClient'

import { failureOf, requireSuccess } from '@presentation/feedback/failure'
import type { WorkbenchCommands } from '@presentation/features/workbench-session/workbenchCommands'
import {
  sessionIsDirty,
  useWorkbenchSessionStore
} from '@presentation/features/workbench-session/workbenchSession.store'
import type { WorkbenchSaveState } from '@presentation/features/workbench-session/workbenchSession.types'
import type { SceneExportNotice } from './SceneExportNotice'
import {
  latestSavedSceneVersionOfResult,
  normalizeSavedSceneVersionFact,
  savedSceneVersionOfResult,
  sceneExportEntryOf,
  type SceneExportEntry
} from './sceneExportEntry'
import { exportNoticeOf, exportRequestOf } from './sceneTaskPresentation'
import type { SavedSceneVersionFact } from './WorkbenchPreviewLayer'

const EXPORT_NOTICE_CLEAR_MS = 5000

export interface WorkbenchExportScope {
  readonly opened: { readonly id: string } | null
  readonly projectId: string
  readonly sceneId: string
}

export interface WorkbenchExportVersionScope {
  readonly projectId: string
  readonly sceneId: string
}

export interface WorkbenchExportEntryInputs {
  readonly pageBlocked: boolean
  readonly workspaceBlocked: boolean
  readonly generationActive: boolean
  readonly viewStale: boolean
  readonly saveState: WorkbenchSaveState
  readonly saveLabel: string
}

export interface WorkbenchExportGenerationSettled {
  readonly succeeded: boolean
  readonly commitId: string | null
  readonly operationId: string | null
}

export interface WorkbenchExportControllerOptions {
  readonly sceneExportClient: SceneExportClient
  readonly scope: WorkbenchExportScope
  readonly entry: WorkbenchExportEntryInputs
  readonly commands: WorkbenchCommands
  readonly refreshPreviewAvailability: () => void
  readonly generationSettled: WorkbenchExportGenerationSettled
}

export type SceneExportDestinationMode = 'workspace' | 'selected'

export interface SceneExportDestinationSelection {
  readonly selectionId: string
  readonly directoryPath: string
}

export interface WorkbenchExportDestinationDialog {
  readonly open: boolean
  readonly mode: SceneExportDestinationMode
  readonly selection: SceneExportDestinationSelection | null
  readonly choosing: boolean
  readonly error: string | null
  readonly selectMode: (mode: SceneExportDestinationMode) => void
  readonly choose: () => void
  readonly confirm: () => void
  readonly close: () => void
}

export interface WorkbenchExportController {
  readonly notice: SceneExportNotice | null
  readonly exporting: boolean
  readonly entry: SceneExportEntry
  readonly destinationDialog: WorkbenchExportDestinationDialog
  readonly acceptSavedVersion: (
    saved: SavedSceneVersionFact,
    scope: WorkbenchExportVersionScope
  ) => void
  readonly dismissNotice: () => void
  readonly beginExport: () => void
  readonly runExport: (destination?: SceneExportDestinationDTO) => Promise<void>
}

/** 工作台导出唯一所有者：目的地弹窗、最新可导出正式版本、导出提示、运行守卫与前置恢复。 */
export function useWorkbenchExportController(
  options: WorkbenchExportControllerOptions
): WorkbenchExportController {
  const {
    sceneExportClient,
    scope,
    entry: entryInputs,
    commands,
    refreshPreviewAvailability,
    generationSettled
  } = options
  const { opened, projectId, sceneId } = scope
  const { succeeded, commitId, operationId } = generationSettled
  const [savedSceneVersion, setSavedSceneVersion] = useState<SavedSceneVersionFact | null>(null)
  const [notice, setNotice] = useState<SceneExportNotice | null>(null)
  const [exporting, setExporting] = useState(false)
  const [destinationOpen, setDestinationOpen] = useState(false)
  const [destinationMode, setDestinationMode] = useState<SceneExportDestinationMode>('workspace')
  const [destinationSelection, setDestinationSelection] =
    useState<SceneExportDestinationSelection | null>(null)
  const [choosingDestination, setChoosingDestination] = useState(false)
  const [destinationError, setDestinationError] = useState<string | null>(null)
  const exportingRef = useRef(false)
  const exportRun = useRef(0)
  const hydrationRun = useRef(0)
  const previewSavedDuringHydration = useRef(false)

  /* 提交和场景身份变化都让旧版本失效：布局阶段先作废在途查询并清空旧事实，
     实际可导出版本仍由下方统一查询从后端重新读取。 */
  const previousSettled = useRef({ succeeded, commitId, operationId })
  const previousScope = useRef({ opened, projectId, sceneId, sceneExportClient })

  useLayoutEffect(() => {
    const previous = previousScope.current
    const changed =
      previous.opened !== opened ||
      previous.projectId !== projectId ||
      previous.sceneId !== sceneId ||
      previous.sceneExportClient !== sceneExportClient
    previousScope.current = { opened, projectId, sceneId, sceneExportClient }
    if (!changed) return
    hydrationRun.current += 1
    setSavedSceneVersion(null)
    setDestinationOpen(false)
    setDestinationSelection(null)
    setDestinationError(null)
  }, [opened, projectId, sceneId, sceneExportClient])

  useLayoutEffect(() => {
    const previous = previousSettled.current
    const changed =
      previous.succeeded !== succeeded ||
      previous.commitId !== commitId ||
      previous.operationId !== operationId
    previousSettled.current = { succeeded, commitId, operationId }
    if (!changed || !succeeded) return
    hydrationRun.current += 1
    setSavedSceneVersion(null)
    setNotice(null)
    setDestinationOpen(false)
    setDestinationSelection(null)
    setDestinationError(null)
  }, [succeeded, commitId, operationId])

  useEffect(() => {
    if (!succeeded) return
    refreshPreviewAvailability()
  }, [succeeded, commitId, refreshPreviewAvailability])

  useEffect(() => {
    if (notice?.tone !== 'ok' || notice.directoryPath) return
    const timer = setTimeout(() => setNotice(null), EXPORT_NOTICE_CLEAR_MS)
    return () => clearTimeout(timer)
  }, [notice])

  /* 挂载、切换场景和生成提交后都从后端恢复同一份「最新可导出正式版本」：
     预览保存与生成提交一起参与，旧作用域或被预览保存超越的查询结果不得回写。 */
  useEffect(() => {
    if (opened === null || projectId.length === 0 || sceneId.length === 0) return
    const run = ++hydrationRun.current
    previewSavedDuringHydration.current = false
    const appliesToCurrentScope = (): boolean => {
      if (run !== hydrationRun.current || previewSavedDuringHydration.current) return false
      const state = useWorkbenchSessionStore.getState()
      return state.projectId === projectId && state.sceneId === sceneId
    }
    void (async (): Promise<void> => {
      try {
        const result = await sceneExportClient.readLatestSavedSceneVersion({ projectId, sceneId })
        if (!appliesToCurrentScope()) return
        setSavedSceneVersion(savedSceneVersionOfResult(latestSavedSceneVersionOfResult(result)))
      } catch {
        if (!appliesToCurrentScope()) return
        setSavedSceneVersion(null)
      }
    })()
    return () => {
      if (run === hydrationRun.current) hydrationRun.current += 1
    }
  }, [opened, projectId, sceneId, sceneExportClient, succeeded, commitId, operationId])

  useEffect(
    () => () => {
      exportRun.current += 1
    },
    []
  )

  const acceptSavedVersion = useCallback(
    (saved: SavedSceneVersionFact, source: WorkbenchExportVersionScope): void => {
      /* 旧预览会话的迟到回调不能把旧场景的保存结果写给当前场景。 */
      if (source.projectId !== projectId || source.sceneId !== sceneId) return
      const version = normalizeSavedSceneVersionFact(saved)
      if (!version) return
      previewSavedDuringHydration.current = true
      hydrationRun.current += 1
      setSavedSceneVersion(version)
      setNotice(null)
    },
    [projectId, sceneId]
  )

  const dismissNotice = useCallback((): void => setNotice(null), [])

  const entry = sceneExportEntryOf({
    savedSceneVersion,
    exporting,
    pageBlocked: entryInputs.pageBlocked,
    workspaceBlocked: entryInputs.workspaceBlocked,
    generationActive: entryInputs.generationActive,
    viewStale: entryInputs.viewStale,
    saveState: entryInputs.saveState,
    saveLabel: entryInputs.saveLabel
  })

  const runExport = useCallback(
    async (destination?: SceneExportDestinationDTO): Promise<void> => {
      const version = savedSceneVersion
      if (!version || exportingRef.current || !entry.canRun) return
      exportingRef.current = true
      const run = ++exportRun.current
      setExporting(true)
      setNotice({
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
          if (
            sessionIsDirty(state) ||
            (state.saveState !== 'saved' && state.saveState !== 'idle')
          ) {
            setNotice({
              tone: 'danger',
              label: '导出已停止',
              detail: state.saveError?.msg ?? '工作台改动没有保存成功，导出已停止。'
            })
            return
          }
        }
        const result = requireSuccess(
          await sceneExportClient.exportSavedScene(
            exportRequestOf(projectId, sceneId, version, destination)
          )
        )
        if (run !== exportRun.current) return
        setNotice(exportNoticeOf(result))
      } catch (error) {
        if (run !== exportRun.current) return
        const failure = failureOf(error)
        setNotice({ tone: 'danger', label: '导出失败', detail: failure.msg })
      } finally {
        exportingRef.current = false
        if (run === exportRun.current) setExporting(false)
      }
    },
    [commands, entry.canRun, projectId, savedSceneVersion, sceneExportClient, sceneId]
  )

  /* 两个入口都只打开同一个目的地弹窗；取消弹窗不发送导出请求、不写盘。
     上一轮结果属于旧浮层状态，打开新弹窗时收起，避免浮层与弹窗同时出现。 */
  const beginExport = useCallback((): void => {
    if (exportingRef.current || !entry.canRun) return
    setNotice(null)
    setDestinationMode('workspace')
    setDestinationSelection(null)
    setDestinationError(null)
    setDestinationOpen(true)
  }, [entry.canRun])

  const selectMode = useCallback((mode: SceneExportDestinationMode): void => {
    setDestinationMode(mode)
    setDestinationError(null)
  }, [])

  const closeDestination = useCallback((): void => {
    setDestinationOpen(false)
    setDestinationError(null)
  }, [])

  const chooseDestination = useCallback((): void => {
    setDestinationMode('selected')
    setDestinationError(null)
    setChoosingDestination(true)
    void (async (): Promise<void> => {
      try {
        const choice = requireSuccess(
          await sceneExportClient.chooseSceneExportDirectory({ projectId, sceneId })
        )
        if (choice.status === 'selected') {
          setDestinationSelection({
            selectionId: choice.selectionId,
            directoryPath: choice.directoryPath
          })
          return
        }
        /* 系统选择器取消不是失败：保持弹窗，当前仍未选择目录。 */
        setDestinationSelection(null)
      } catch (error) {
        setDestinationError(failureOf(error).msg)
      } finally {
        setChoosingDestination(false)
      }
    })()
  }, [projectId, sceneExportClient, sceneId])

  const confirmExport = useCallback((): void => {
    if (destinationMode === 'workspace') {
      setDestinationOpen(false)
      void runExport({ kind: 'workspace' })
      return
    }
    const selection = destinationSelection
    if (selection === null) return
    setDestinationOpen(false)
    void runExport({ kind: 'selected', selectionId: selection.selectionId })
  }, [destinationMode, destinationSelection, runExport])

  return {
    notice,
    exporting,
    entry,
    destinationDialog: {
      open: destinationOpen,
      mode: destinationMode,
      selection: destinationSelection,
      choosing: choosingDestination,
      error: destinationError,
      selectMode,
      choose: chooseDestination,
      confirm: confirmExport,
      close: closeDestination
    },
    acceptSavedVersion,
    dismissNotice,
    beginExport,
    runExport
  }
}
