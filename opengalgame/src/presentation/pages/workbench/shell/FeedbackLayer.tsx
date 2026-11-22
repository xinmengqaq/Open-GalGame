import { clsx } from 'clsx'
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactElement,
  type ReactNode
} from 'react'
import { createPortal } from 'react-dom'

import { setFeedbackToastTarget } from '@presentation/feedback/toastHostTarget'
import theme from '../workbenchTheme.module.css'
import styles from './workbenchShell.module.css'

interface FeedbackLayerProps {
  children?: ReactNode
  active?: boolean
  topOffset?: number
  onNoticeSlotChange?: (node: HTMLElement | null) => void
}

export function FeedbackLayer({
  children,
  active = false,
  topOffset = 0,
  onNoticeSlotChange
}: FeedbackLayerProps): ReactElement {
  const [host] = useState(() => document.createElement('div'))
  const shelfRef = useRef<HTMLDivElement>(null)
  const toastSlotRef = useRef<HTMLDivElement>(null)
  const noticeSlotRef = useRef<HTMLDivElement>(null)
  const [toastHeight, setToastHeight] = useState(0)
  const [present, setPresent] = useState(false)
  const open = active || present

  const registerNoticeSlot = useCallback(
    (node: HTMLDivElement | null) => {
      noticeSlotRef.current = node
      onNoticeSlotChange?.(node)
    },
    [onNoticeSlotChange]
  )

  useEffect(() => {
    document.body.appendChild(host)
    const shelf = shelfRef.current
    const toastSlot = toastSlotRef.current
    if (!shelf || !toastSlot) return
    setFeedbackToastTarget(toastSlot)

    let presenceFrame = 0
    function syncPresence(): void {
      presenceFrame = 0
      const toast = toastSlot?.querySelector<HTMLElement>('[data-sonner-toast]')
      setToastHeight(toast ? Math.ceil(toast.getBoundingClientRect().height) : 0)
      setPresent(Boolean(toast) || Boolean(noticeSlotRef.current?.childElementCount))
    }
    function schedulePresence(): void {
      if (!presenceFrame) presenceFrame = requestAnimationFrame(syncPresence)
    }

    let parentFrame = 0
    function syncParent(): void {
      parentFrame = 0
      const dialogs = Array.from(
        document.querySelectorAll<HTMLElement>('dialog[open], [role="dialog"][data-state="open"]')
      )
      const parent = dialogs.at(-1) ?? document.body
      if (host.parentElement !== parent) {
        const footer = parent.tagName === 'DIALOG' ? parent.querySelector('footer') : null
        if (footer?.parentElement) footer.parentElement.insertBefore(host, footer)
        else parent.appendChild(host)
      }
      if (shelfRef.current)
        shelfRef.current.dataset.host = parent.tagName === 'DIALOG' ? 'dialog' : 'page'
    }
    function scheduleParent(): void {
      if (!parentFrame) parentFrame = requestAnimationFrame(syncParent)
    }

    function involvesDialog(record: MutationRecord): boolean {
      if (record.type === 'attributes') {
        return (
          record.target instanceof Element &&
          record.target.matches('dialog, [role="dialog"], [role="alertdialog"]')
        )
      }
      return [...record.addedNodes, ...record.removedNodes].some(
        (node) =>
          node instanceof Element &&
          (node.matches('dialog, [role="dialog"], [role="alertdialog"]') ||
            node.querySelector('dialog, [role="dialog"], [role="alertdialog"]') !== null)
      )
    }

    const shelfObserver = new MutationObserver(schedulePresence)
    shelfObserver.observe(shelf, { childList: true, subtree: true, characterData: true })
    const dialogObserver = new MutationObserver((records) => {
      if (records.some(involvesDialog)) scheduleParent()
    })
    dialogObserver.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['open', 'data-state']
    })

    syncPresence()
    syncParent()
    return () => {
      cancelAnimationFrame(presenceFrame)
      cancelAnimationFrame(parentFrame)
      shelfObserver.disconnect()
      dialogObserver.disconnect()
      setFeedbackToastTarget(null)
      host.remove()
    }
  }, [host])

  return createPortal(
    <div
      ref={shelfRef}
      className={clsx(styles.shelf, theme.theme)}
      data-open={open}
      data-testid="workbench-feedback"
      role="region"
      aria-label="工作台反馈"
      inert={!open}
      style={{ '--feedback-top': `${topOffset}px` } as CSSProperties}
    >
      <div className={styles.shelfInner}>
        <div
          ref={toastSlotRef}
          className={styles.toastSlot}
          style={{ '--toast-height': `${toastHeight}px` } as CSSProperties}
        />
        <div ref={registerNoticeSlot} className={styles.noticeSlot} />
        {children}
      </div>
    </div>,
    host
  )
}
