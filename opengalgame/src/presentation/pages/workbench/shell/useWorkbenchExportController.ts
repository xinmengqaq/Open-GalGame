import { useCallback, useEffect, useRef, useState } from 'react'

import type { SceneExportClient } from '@interfaces/scene-export/client/SceneExportClient'

import { failureOf, requireSuccess } from '@presentation/feedback/failure'
import type { WorkbenchCommands } from '@presentation/features/workbench-session/workbenchCommands'
import {
  sessionIsDirty,
  useWorkbenchSessionStore
} from '@presentation/features/workbench-session/workbenchSession.store'
import type {
  WorkbenchSaveState
} from '@presentation/features/workbench-session/workbenchSession.types'
import type { SceneExportNotice } from './SceneExportStatus'
import {
  latestPreviewSaveOfResult,
  savedSceneVersionOfPreviewSave,
  sceneExportEntryOf,
  type SceneExportEntry
} from './sceneExportEntry'
import { exportNoticeOf, exportRequestOf } from './sceneTaskPresentation'
import type { SavedSceneVersionFact } from './WorkbenchPreviewLayer'

/** 成功导出且没有可打开目录时，提示自动收起。 */
const EXPORT_NOTICE_CLEAR_MS = 5000

export interface WorkbenchExportScope {
  readonly opened: { readonly id: string } | null
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
}

export interface WorkbenchExportControllerOptions {
  readonly sceneExportClient: SceneExportClient
  readonly scope: WorkbenchExportScope
  readonly entry: WorkbenchExportEntryInputs
  readonly commands: WorkbenchCommands
  readonly refreshPreviewAvailability: () => void
  readonly generationSettled: WorkbenchExportGenerationSettled
}

export interface WorkbenchExportController {
  readonly notice: SceneExportNotice | null
  readonly exporting: boolean
  readonly entry: SceneExportEntry
  readonly acceptSavedVersion: (saved: SavedSceneVersionFact) => void
  readonly dismissNotice: () => void
  readonly runExport: () => Promise<void>
}

/** 工作台导出唯一所有者：已结算保存版本、导出提示、运行守卫与导出前置恢复。 */
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
  const { succeeded, commitId } = generationSettled
  const [savedSceneVersion, setSavedSceneVersion] = useState<SavedSceneVersionFact | null>(null)
  const [notice, setNotice] = useState<SceneExportNotice | null>(null)
  const [exporting, setExporting] = useState(false)
  const exportingRef = useRef(false)
  const exportRun = useRef(0)
  const hydrationRun = useRef(0)
  const previewSavedDuringHydration = useRef(false)

  /* 生成提交后旧版本与旧提示失效：在渲染期按「已成功 + commitId」键控清空，
     不从 scope/commit 派生显示值，导出结果提示仍由 setNotice 独立写入。 */
  const [seenSettled, setSeenSettled] = useState({ succeeded, commitId })

  /* 重载或切换场景时先清掉旧版本；实际恢复仍由下方 effect 从后端读取。
     快照比较保持原 effect 的依赖边界（含 opened 与 client 身份）。 */
  const [hydrationSource, setHydrationSource] = useState({
    opened,
    projectId,
    sceneId,
    sceneExportClient
  })

  if (seenSettled.succeeded !== succeeded || seenSettled.commitId !== commitId) {
    setSeenSettled({ succeeded, commitId })
    if (succeeded) {
      setSavedSceneVersion(null)
      setNotice(null)
    }
  }
  if (
    hydrationSource.opened !== opened ||
    hydrationSource.projectId !== projectId ||
    hydrationSource.sceneId !== sceneId ||
    hydrationSource.sceneExportClient !== sceneExportClient
  ) {
    setHydrationSource({ opened, projectId, sceneId, sceneExportClient })
    setSavedSceneVersion(null)
  }

  useEffect(() => {
    if (!succeeded) return
    refreshPreviewAvailability()
  }, [succeeded, commitId, refreshPreviewAvailability])

  useEffect(() => {
    if (notice?.tone !== 'ok' || notice.directoryPath) return
    const timer = setTimeout(() => setNotice(null), EXPORT_NOTICE_CLEAR_MS)
    return () => clearTimeout(timer)
  }, [notice])

  /* 重载或切换场景后从后端恢复导出前置：只采用已结算的预览保存，不伪造版本。 */
  useEffect(() => {
    if (opened === null || projectId.length === 0 || sceneId.length === 0) return
    const run = ++hydrationRun.current
    previewSavedDuringHydration.current = false
    /* 旧作用域的读取可能在新作用域提交后、passive cleanup 自增 run 前返回；
       应用前按 store 当前作用域再校验一次，旧 scope 不得污染新 scope。 */
    const appliesToCurrentScope = (): boolean => {
      if (run !== hydrationRun.current || previewSavedDuringHydration.current) return false
      const state = useWorkbenchSessionStore.getState()
      return state.projectId === projectId && state.sceneId === sceneId
    }
    void (async (): Promise<void> => {
      try {
        const result = await sceneExportClient.readLatestPreviewSave({ projectId, sceneId })
        if (!appliesToCurrentScope()) return
        setSavedSceneVersion(savedSceneVersionOfPreviewSave(latestPreviewSaveOfResult(result)))
      } catch {
        if (!appliesToCurrentScope()) return
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

  const acceptSavedVersion = useCallback((saved: SavedSceneVersionFact): void => {
    if (saved.requestId.trim() === '' || saved.contentBasis.digest.trim() === '') return
    previewSavedDuringHydration.current = true
    setSavedSceneVersion(saved)
    setNotice(null)
  }, [])

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

  const runExport = useCallback(async (): Promise<void> => {
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
        if (sessionIsDirty(state) || (state.saveState !== 'saved' && state.saveState !== 'idle')) {
          setNotice({
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
      setNotice(exportNoticeOf(result))
    } catch (error) {
      if (run !== exportRun.current) return
      const failure = failureOf(error)
      setNotice({ tone: 'danger', label: '导出失败', detail: failure.msg })
    } finally {
      exportingRef.current = false
      if (run === exportRun.current) setExporting(false)
    }
  }, [commands, entry.canRun, projectId, savedSceneVersion, sceneExportClient, sceneId])

  return {
    notice,
    exporting,
    entry,
    acceptSavedVersion,
    dismissNotice,
    runExport
  }
}
