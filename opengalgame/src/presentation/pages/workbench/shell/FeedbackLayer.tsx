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
  /** 顶栏实际高度：无弹窗时反馈固定在它下方；弹窗内改用流内位置。 */
  topOffset?: number
  onNoticeSlotChange?: (node: HTMLElement | null) => void
}

/**
 * 唯一反馈浮层。没有弹窗时固定在工作台顶栏下方的中央安全位，位置不随遮挡重算；
 * 打开原生居中弹窗时迁入最上层 dialog 操作栏之前的流内位置，浮在遮罩之上且不盖输入。
 * 不抢焦点。
 */
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
      // 只迁入普通对话框/抽屉；确认框里不承载 Toast，避免结果条叠进确认内容。
      const dialogs = Array.from(
        document.querySelectorAll<HTMLElement>('dialog[open], [role="dialog"][data-state="open"]')
      )
      const parent = dialogs.at(-1) ?? document.body
      if (host.parentElement !== parent) {
        // 原生居中弹窗会成为 fixed 子元素的包含块（弹窗自身有 backdrop-filter），
        // 固定浮层会落回弹窗内部盖住标题和输入。这里改为插到操作栏之前的流内一条，
        // 不遮内容也不改 Dialog 的居中方式；右侧抽屉等其他弹层保持固定浮层。
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
