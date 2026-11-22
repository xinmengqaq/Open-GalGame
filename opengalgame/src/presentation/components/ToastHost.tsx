import { clsx } from 'clsx'
import { useSyncExternalStore, type ReactElement } from 'react'
import { createPortal } from 'react-dom'
import { Toaster } from 'sonner'

import { feedbackToastTarget, subscribeFeedbackToastTarget } from '../feedback/toastHostTarget'
import styles from './ToastHost.module.css'

export function ToastHost(): ReactElement {
  const target = useSyncExternalStore(subscribeFeedbackToastTarget, feedbackToastTarget, () => null)
  const embedded = target !== null
  const toaster = (
    <Toaster
      className={clsx(styles.host, embedded && styles.embedded)}
      position={embedded ? 'top-center' : 'top-right'}
      offset={embedded ? 0 : { top: 96, right: 24 }}
      mobileOffset={embedded ? 0 : { top: 96, right: 16 }}
      gap={embedded ? 6 : 8}
      closeButton={embedded}
      visibleToasts={embedded ? 1 : 3}
      duration={embedded ? 3000 : 4000}
    />
  )
  return target ? createPortal(toaster, target) : toaster
}
