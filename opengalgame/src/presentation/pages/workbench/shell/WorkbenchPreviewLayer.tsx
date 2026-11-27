import { useEffect, useRef, type ReactElement } from 'react'
import { createPortal } from 'react-dom'

import type { SceneContentBasisVO } from '@application/scene-preview/vo/ScenePreviewSessionVO'
import type { SceneExportVersionReference } from '@application/scene-export/vo/SceneExportVO'
import { setGuidePreviewHost } from '@presentation/features/beginner-guide/guideTopLayer'
import type { ScenePreviewClient } from '@interfaces/scene-preview/client/ScenePreviewClient'
import { PreviewPage } from '@presentation/pages/preview/PreviewPage'
import type {
  PreviewSaveCleared,
  PreviewSaveStarted,
  PreviewSaveUnsettled,
  PreviewSavedVersion
} from '@presentation/pages/preview/usePreviewSaveSettlement'
import styles from '../WorkbenchPage.module.css'

export type SavedSceneVersionFact = {
  versionReference: SceneExportVersionReference
  contentBasis: SceneContentBasisVO
}

interface WorkbenchPreviewLayerProps {
  client: ScenePreviewClient
  projectId: string
  sceneId: string
  projectName: string
  sceneLabel: string
  returnFocusTo: HTMLElement | null
  onExit: () => void
  onSavedVersion: (saved: SavedSceneVersionFact) => void
  /** 开始一次保存时上报；observer 用 requestId 区分迟到结果。 */
  onDialogueSaveStarted?: (event: PreviewSaveStarted) => void
  /** 直接保存或结算确认后上报；observer 按 requestId 去重。 */
  onDialogueSaved?: (saved: PreviewSavedVersion) => void
  /** 保存失败或结果待核对时上报；不显示成功。 */
  onDialogueSaveUnsettled?: (event: PreviewSaveUnsettled) => void
  /** 未处理的保存已结算为无改动，或用户明确放弃草稿退出。 */
  onDialogueSaveCleared?: (event: PreviewSaveCleared) => void
  /** 预览里出现了真实未保存改词；只传有无。 */
  onDialogueDraftChanged?: (dirty: boolean) => void
}

export function WorkbenchPreviewLayer({
  client,
  projectId,
  sceneId,
  projectName,
  sceneLabel,
  returnFocusTo,
  onExit,
  onSavedVersion,
  onDialogueSaveStarted,
  onDialogueSaved,
  onDialogueSaveUnsettled,
  onDialogueSaveCleared,
  onDialogueDraftChanged
}: WorkbenchPreviewLayerProps): ReactElement {
  const layerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const appRoot = document.getElementById('root')
    appRoot?.setAttribute('inert', '')
    const frame = requestAnimationFrame(() => layerRef.current?.focus({ preventScroll: true }))

    function restoreLayerFocus(): void {
      const active = document.activeElement
      if (active instanceof HTMLElement && layerRef.current?.contains(active)) return
      if (
        document.querySelector(
          'dialog[open], [role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"]'
        )
      ) {
        return
      }
      if (!(active instanceof HTMLElement) || active === document.body || active.closest('#root')) {
        layerRef.current?.focus({ preventScroll: true })
      }
    }
    let focusFrame = 0
    function scheduleFocusRestore(): void {
      if (focusFrame) return
      focusFrame = requestAnimationFrame(() => {
        focusFrame = 0
        restoreLayerFocus()
      })
    }
    function onFocusOut(event: FocusEvent): void {
      if (event.target instanceof Node && layerRef.current?.contains(event.target)) {
        scheduleFocusRestore()
      }
    }
    document.addEventListener('focusin', scheduleFocusRestore)
    document.addEventListener('focusout', onFocusOut)

    return () => {
      cancelAnimationFrame(frame)
      cancelAnimationFrame(focusFrame)
      document.removeEventListener('focusin', scheduleFocusRestore)
      document.removeEventListener('focusout', onFocusOut)
      appRoot?.removeAttribute('inert')
      if (returnFocusTo) {
        window.setTimeout(() => returnFocusTo.focus({ preventScroll: true }), 0)
      }
    }
  }, [returnFocusTo])

  return createPortal(
    <div
      ref={layerRef}
      className={styles.previewLayer}
      data-testid="workbench-preview-layer"
      role="dialog"
      aria-modal="true"
      aria-label="试玩预览"
      tabIndex={-1}
    >
      <PreviewPage
        client={client}
        projectId={projectId}
        sceneId={sceneId}
        projectName={projectName}
        sceneLabel={sceneLabel}
        onExit={onExit}
        onSaveStarted={(event) => {
          try {
            onDialogueSaveStarted?.(event)
          } catch {
            // 指引观察者异常不能打断预览保存请求。
          }
        }}
        onSavedVersion={(saved) => {
          onSavedVersion({
            versionReference: { kind: 'preview-save', requestId: saved.requestId },
            contentBasis: saved.contentBasis
          })
          try {
            onDialogueSaved?.(saved)
          } catch {
            // 指引观察者异常不能打断预览保存的成功提示。
          }
        }}
        onSaveUnsettled={(event) => {
          try {
            onDialogueSaveUnsettled?.(event)
          } catch {
            // 指引观察者异常不能打断预览保存的失败或待核对提示。
          }
        }}
        onSaveCleared={(event) => {
          try {
            onDialogueSaveCleared?.(event)
          } catch {
            // 指引观察者异常不能打断预览会话关闭。
          }
        }}
        onDraftDirtyChange={(dirty) => {
          try {
            onDialogueDraftChanged?.(dirty)
          } catch {
            // 指引观察者异常不能打断预览草稿编辑。
          }
        }}
      />
      {/* 新手教程 portal 的同级槽位：留在预览对话框的焦点范围内，绘制层级高于舞台。 */}
      <div
        ref={setGuidePreviewHost}
        className={styles.guideLayer}
        data-guide-top-layer-host="preview"
      />
    </div>,
    document.body
  )
}
