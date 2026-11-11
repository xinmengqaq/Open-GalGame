import { useCallback, useEffect, useRef, type ReactElement } from 'react'
import { createPortal } from 'react-dom'

import type { ProjectFilesClient } from '@interfaces/project-files/client/ProjectFilesClient'
import { useWorkbenchCommands } from '../workbench-session/workbenchCommandsContext'
import { sourceFactsOf, documentLayerCardOf } from '../workbench-session/workbenchSessionSelectors'
import type { SessionDocumentCard } from '../workbench-session/workbenchSession.types'
import { useWorkbenchSessionStore } from '../workbench-session/workbenchSession.store'
import { useShallow } from 'zustand/react/shallow'

import { DocumentContentView } from './DocumentContentView'
import { DocumentLayerHeader } from './DocumentLayerHeader'
import { useDocumentBody } from './useDocumentLayer'
import { useDocumentBodyEditor } from './useDocumentBodyEditor'
import { useDocumentLayerMotion } from './useDocumentLayerMotion'
import styles from './DocumentLayer.module.css'

interface DocumentLayerProps {
  client: ProjectFilesClient
}

/** 文档层。Markdown 文档可编辑并保存；Esc、返回按钮或点击遮罩关闭，脏正文先确认。 */
export function DocumentLayer({ client }: DocumentLayerProps): ReactElement | null {
  const card = useWorkbenchSessionStore(documentLayerCardOf)
  if (!card) return null
  return createPortal(<DocumentLayerContent client={client} card={card} />, document.body)
}

function DocumentLayerContent({
  client,
  card
}: {
  client: ProjectFilesClient
  card: SessionDocumentCard
}): ReactElement {
  const commands = useWorkbenchCommands()
  const view = useDocumentBody(client, card)
  const detail = useWorkbenchSessionStore(
    useShallow((state) => {
      const source = sourceFactsOf(state, card.sourceId)
      return source.detail?.contentKind === 'text' ? source.detail : undefined
    })
  )
  const editor = useDocumentBodyEditor(client, card, view, detail)
  const { overlayRef, sheetRef, closeWithMotion } = useDocumentLayerMotion(card.cardId)
  const backButtonRef = useRef<HTMLButtonElement>(null)
  const titleId = `document-layer-title-${card.cardId}`
  const dirtyRef = useRef(editor.dirty)

  useEffect(() => {
    dirtyRef.current = editor.dirty
  }, [editor.dirty])

  const close = useCallback(() => {
    if (dirtyRef.current && !window.confirm('正文有未保存的改动，确定关闭文档层吗？')) return
    closeWithMotion(() => commands.closeDocumentLayer())
  }, [closeWithMotion, commands])

  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const focusTimer = window.setTimeout(
      () => backButtonRef.current?.focus({ preventScroll: true }),
      0
    )
    return () => {
      window.clearTimeout(focusTimer)
      previous?.focus({ preventScroll: true })
    }
  }, [])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopImmediatePropagation()
        close()
        return
      }
      const target = event.target
      const editing =
        target instanceof HTMLElement &&
        (target.isContentEditable ||
          target.closest('input, textarea, [contenteditable="true"]') !== null)
      if ((event.ctrlKey || event.metaKey) && ['z', 'y'].includes(event.key.toLowerCase())) {
        if (!editing) event.stopImmediatePropagation()
        return
      }
      if (event.key === 'Delete') {
        if (!editing) event.stopImmediatePropagation()
        return
      }
      if (event.key !== 'Tab') return
      const root = overlayRef.current
      if (!root) return
      const focusable = Array.from(
        root.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [contenteditable="true"], [tabindex]:not([tabindex="-1"])'
        )
      ).filter((element) => element.offsetParent !== null)
      if (focusable.length === 0) return
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [close, overlayRef])

  return (
    <div
      ref={overlayRef}
      className={styles.layer}
      data-testid="document-layer"
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) close()
      }}
    >
      <span className={styles.layerGlow} aria-hidden="true" />
      <div ref={sheetRef} className={styles.sheet}>
        <DocumentLayerHeader
          card={card}
          onBack={close}
          backButtonRef={backButtonRef}
          titleId={titleId}
          editable={editor.editable}
          dirty={editor.dirty}
          saving={editor.saving}
          error={editor.error}
          onSave={() => void editor.save()}
        />
        <DocumentContentView
          card={card}
          view={view}
          editable={editor.editable}
          draft={editor.draft}
          error={editor.error}
          conflict={editor.conflict}
          onChange={editor.setDraft}
          onSave={() => void editor.save()}
          reloadLatest={editor.reloadLatest}
        />
      </div>
    </div>
  )
}
