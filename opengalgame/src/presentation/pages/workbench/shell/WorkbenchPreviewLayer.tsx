import { useEffect, useRef, type ReactElement } from 'react'
import { createPortal } from 'react-dom'

import type { SceneContentBasisVO } from '@application/scene-preview/vo/ScenePreviewSessionVO'
import type { ScenePreviewClient } from '@interfaces/scene-preview/client/ScenePreviewClient'
import { PreviewPage } from '@presentation/pages/preview/PreviewPage'
import styles from '../WorkbenchPage.module.css'

export type SavedSceneVersionFact = {
  requestId: string
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
}

/**
 * 预览是工作台之上的独立层：挂到 body，遮住工作台并让工作台 inert。
 * 关闭后回到打开前的焦点；前后都不滚动工作台外壳。
 */
export function WorkbenchPreviewLayer({
  client,
  projectId,
  sceneId,
  projectName,
  sceneLabel,
  returnFocusTo,
  onExit,
  onSavedVersion
}: WorkbenchPreviewLayerProps): ReactElement {
  const layerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const appRoot = document.getElementById('root')
    appRoot?.setAttribute('inert', '')
    const frame = requestAnimationFrame(() => layerRef.current?.focus({ preventScroll: true }))

    // 保存等重渲染可能让聚焦按钮失效并把焦点丢回 body；没有预览内弹窗时拉回预览层。
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
        onSavedVersion={onSavedVersion}
      />
    </div>,
    document.body
  )
}
