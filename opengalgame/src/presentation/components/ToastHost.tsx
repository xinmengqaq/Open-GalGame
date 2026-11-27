import { clsx } from 'clsx'
import {
  useEffect,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type ReactElement
} from 'react'
import { createPortal } from 'react-dom'
import { Toaster } from 'sonner'

import { feedbackToastTarget, subscribeFeedbackToastTarget } from '../feedback/toastHostTarget'
import styles from './ToastHost.module.css'

/**
 * 原生 modal 打开后位于 top layer，modal 外的 fixed 提示会被遮罩盖住。
 * 把全局提示挂到最上层已打开的原生 dialog 内，提示仍按视口右上角定位。
 */
function useTopLayerDialog(): HTMLDialogElement | null {
  const [target, setTarget] = useState<HTMLDialogElement | null>(null)

  useEffect(() => {
    const update = (): void => {
      const dialogs = Array.from(document.querySelectorAll<HTMLDialogElement>('dialog[open]'))
      setTarget(dialogs.at(-1) ?? null)
    }
    update()
    const observer = new MutationObserver(update)
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['open']
    })
    return () => observer.disconnect()
  }, [])

  return target
}

export function ToastHost(): ReactElement {
  const feedbackTarget = useSyncExternalStore(
    subscribeFeedbackToastTarget,
    feedbackToastTarget,
    () => null
  )
  const topLayerDialog = useTopLayerDialog()
  const embedded = feedbackTarget !== null
  const target = feedbackTarget ?? topLayerDialog
  const toaster = (
    <Toaster
      className={clsx(styles.host, embedded && styles.embedded)}
      style={embedded ? undefined : ({ '--width': '240px' } as CSSProperties)}
      position={embedded ? 'top-center' : 'top-right'}
      offset={embedded ? 0 : { top: 96, right: 24 }}
      mobileOffset={embedded ? 0 : { top: 96, right: 16 }}
      gap={embedded ? 6 : 8}
      closeButton
      toastOptions={{ closeButtonAriaLabel: '关闭通知' }}
      visibleToasts={embedded ? 1 : 3}
      duration={embedded ? 3000 : 4000}
    />
  )
  return target ? createPortal(toaster, target) : toaster
}
