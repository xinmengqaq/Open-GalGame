import { useGSAP } from '@gsap/react'
import gsap from 'gsap'
import { useEffect, useId, useRef, useState, type ReactElement, type ReactNode } from 'react'

import { prefersReducedMotion } from '../effects/motion'
import { DialogElementContext, registerPageModal } from './dialogElement'
import styles from './Dialog.module.css'

interface DialogProps {
  open: boolean
  title: string
  subtitle?: ReactNode
  size?: 'form' | 'wide' | 'narrow'
  placement?: 'center' | 'right'
  /** 首页系输入弹窗使用与工作台一致的圆角玻璃材质。 */
  surface?: 'paper' | 'glass'
  titleClassName?: string
  allowClose: boolean
  onClose: () => void
  /** 关闭按钮的读屏名；默认「关闭弹窗」。 */
  closeLabel?: string
  children: ReactNode
  actions: ReactNode
}

function usesWorkbenchTheme(node: HTMLElement): boolean {
  return getComputedStyle(node).getPropertyValue('--wb-radius-panel').trim() !== ''
}

export function Dialog({
  open,
  title,
  subtitle,
  size = 'form',
  placement = 'center',
  surface = 'paper',
  titleClassName,
  allowClose,
  onClose,
  closeLabel = '关闭弹窗',
  children,
  actions
}: DialogProps): ReactElement {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const shellRef = useRef<HTMLDivElement>(null)
  const returnFocusRef = useRef<HTMLElement | null>(null)
  const titleId = useId()
  const [element, setElement] = useState<HTMLDialogElement | null>(null)
  const [workbench, setWorkbench] = useState(false)

  useEffect(() => {
    setElement(dialogRef.current)
  }, [])

  useEffect(() => {
    const node = dialogRef.current
    if (!node) return
    setWorkbench(usesWorkbenchTheme(node))
  }, [])

  useEffect(() => {
    const node = dialogRef.current
    const shell = shellRef.current
    if (!node) return
    const restoreFocus = (): void => {
      const target = returnFocusRef.current
      returnFocusRef.current = null
      window.requestAnimationFrame(() => {
        const active = document.activeElement
        if (
          (!active || active === document.body) &&
          target?.isConnected &&
          target.getClientRects().length > 0 &&
          !target.matches(':disabled')
        ) {
          target.focus({ preventScroll: true })
        }
      })
    }
    if (open) {
      delete node.dataset.closing
      if (!node.open) {
        returnFocusRef.current =
          document.activeElement instanceof HTMLElement ? document.activeElement : null
        node.showModal()
        // 原生 dialog 默认聚焦第一个可聚焦元素；破坏性确认需要把初始焦点放在安全动作上。
        node.querySelector<HTMLElement>('[data-autofocus]')?.focus()
      }
      // 教程目录本身就是模态框，不能成为自己的挂载目标。
      if (!node.closest('[data-guide-portal]')) return registerPageModal(node)
      return
    }
    if (!node.open) return
    if (placement !== 'right') {
      node.close()
      restoreFocus()
      return
    }
    node.dataset.closing = 'true'
    const targets: Element[] = shell ? [node, shell] : [node]
    gsap.killTweensOf(targets)
    const finish = (): void => {
      delete node.dataset.closing
      if (node.open) node.close()
      gsap.set(targets, { clearProps: 'transform,opacity,visibility' })
      restoreFocus()
    }
    if (prefersReducedMotion()) {
      gsap.to(node, { autoAlpha: 0, duration: 0.12, onComplete: finish })
    } else {
      if (shell) gsap.to(shell, { x: 36, autoAlpha: 0, duration: 0.24, ease: 'power2.in' })
      gsap.to(node, {
        autoAlpha: 0,
        duration: 0.26,
        ease: 'power1.in',
        onComplete: finish
      })
    }
    return () => {
      gsap.killTweensOf(targets)
    }
  }, [open, placement])

  useGSAP(
    () => {
      const dialog = dialogRef.current
      const shell = shellRef.current
      if (!open || !dialog || !shell) return
      const targets: Element[] = [dialog, shell]
      gsap.set(targets, { clearProps: 'transform,opacity,visibility' })
      if (prefersReducedMotion()) {
        gsap.fromTo(
          dialog,
          { opacity: 0 },
          {
            opacity: 1,
            duration: 0.12,
            onComplete: () => gsap.set(targets, { clearProps: 'opacity,visibility' })
          }
        )
        return
      }
      gsap.fromTo(
        dialog,
        { opacity: 0 },
        {
          opacity: 1,
          duration: placement === 'right' ? 0.24 : 0.18,
          ease: 'power2.out'
        }
      )
      gsap.fromTo(
        shell,
        placement === 'right' ? { x: 48, opacity: 0.55 } : { y: 18, scale: 0.965, opacity: 0.85 },
        {
          x: 0,
          y: 0,
          scale: 1,
          opacity: 1,
          duration: placement === 'right' ? 0.42 : 0.3,
          ease: 'power3.out',
          onComplete: () =>
            gsap.set([dialog, shell], { clearProps: 'transform,opacity,visibility' })
        }
      )
    },
    { dependencies: [open, placement] }
  )

  return (
    <DialogElementContext.Provider value={element}>
      <dialog
        ref={dialogRef}
        className={styles.dialog}
        data-size={size}
        data-placement={placement}
        data-theme={
          workbench && placement === 'center'
            ? 'workbench'
            : surface === 'glass'
              ? 'home'
              : undefined
        }
        aria-labelledby={titleId}
        onClick={(event) => {
          if (event.target === dialogRef.current && allowClose) onClose()
        }}
        onCancel={(event) => {
          event.preventDefault()
          if (allowClose) onClose()
        }}
      >
        <div ref={shellRef} className={styles.shell}>
          <header className={styles.header}>
            <div className={styles.titleBlock}>
              <h2 id={titleId} className={titleClassName}>
                {title}
              </h2>
              {subtitle ? <p className={styles.subtitle}>{subtitle}</p> : null}
            </div>
            <button
              type="button"
              className={styles.close}
              aria-label={closeLabel}
              data-tip={closeLabel}
              disabled={!allowClose}
              onClick={() => allowClose && onClose()}
            >
              ×
            </button>
          </header>
          <div className={styles.body}>{children}</div>
          <footer className={styles.actions}>{actions}</footer>
        </div>
      </dialog>
    </DialogElementContext.Provider>
  )
}
