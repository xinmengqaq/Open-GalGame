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
import { documentBodyDisplayable, useDocumentBody } from './useDocumentLayer'
import { useDocumentBodyEditor } from './useDocumentBodyEditor'
import { useDocumentLayerMotion } from './useDocumentLayerMotion'
import styles from './DocumentLayer.module.css'

interface DocumentLayerProps {
  client: ProjectFilesClient
}

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
  const bodyDisplayable = documentBodyDisplayable(view)

  useEffect(() => {
    dirtyRef.current = editor.dirty
  }, [editor.dirty])

  // 打开文档层不等同于读到正文：等缓存或异步读取真正产出可显示正文后再上报。
  // 加载失败、加载中、空正文都不上报；关闭/切卡后由命令层按当前文档层丢弃。
  useEffect(() => {
    if (!bodyDisplayable) return
    commands.reportDocumentBodyReady(card.cardId)
  }, [bodyDisplayable, card.cardId, commands])

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
        // 教程/业务原生 dialog 在 top layer 且是更上层的模态；让它的 cancel
        // 处理 Esc，否则文档层会先吞掉按键并错误关闭自己。
        if (document.querySelector('dialog[open]')) return
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
