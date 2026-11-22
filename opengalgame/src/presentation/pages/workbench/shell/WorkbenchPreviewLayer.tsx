import { useEffect, useRef, type ReactElement } from 'react'
import { createPortal } from 'react-dom'

import type { SceneContentBasisVO } from '@application/scene-preview/vo/ScenePreviewSessionVO'
import type { SceneExportVersionReference } from '@application/scene-export/vo/SceneExportVO'
import type { ScenePreviewClient } from '@interfaces/scene-preview/client/ScenePreviewClient'
import { PreviewPage } from '@presentation/pages/preview/PreviewPage'
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
}

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
        onSavedVersion={(saved) =>
          onSavedVersion({
            versionReference: { kind: 'preview-save', requestId: saved.requestId },
            contentBasis: saved.contentBasis
          })
        }
      />
    </div>,
    document.body
  )
}
