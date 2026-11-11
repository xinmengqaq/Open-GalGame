import { useGSAP } from '@gsap/react'
import gsap from 'gsap'
import { useEffect, useId, useRef, useState, type ReactElement, type ReactNode } from 'react'

import { prefersReducedMotion } from '../effects/motion'
import { DialogElementContext } from './dialogElement'
import styles from './Dialog.module.css'

interface DialogProps {
  open: boolean
  title: string
  subtitle?: ReactNode
  size?: 'form' | 'wide' | 'narrow'
  placement?: 'center' | 'right'
  titleClassName?: string
  allowClose: boolean
  onClose: () => void
  children: ReactNode
  actions: ReactNode
}

/** --wb-* 只在工作台 .theme 子树内定义；探测主题边界，不绑定工作台内部类名。 */
function usesWorkbenchTheme(node: HTMLElement): boolean {
  return getComputedStyle(node).getPropertyValue('--wb-radius-panel').trim() !== ''
}

/**
 * 模态弹窗：开合动画、焦点限制与 Esc。
 * 实现思路：标题标识由 useId 生成，多个弹窗同时挂载时不会都指向文档里第一个。
 * 弹窗元素以状态而非 ref 传给内部浮层，避免渲染期读取 ref。
 * 工作台主题内的居中弹窗换成柔光玻璃材质；右侧抽屉与其他页面保持原有形态。
 */
export function Dialog({
  open,
  title,
  subtitle,
  size = 'form',
  placement = 'center',
  titleClassName,
  allowClose,
  onClose,
  children,
  actions
}: DialogProps): ReactElement {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const shellRef = useRef<HTMLDivElement>(null)
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
    if (open) {
      delete node.dataset.closing
      if (!node.open) node.showModal()
      return
    }
    if (!node.open) return
    if (placement !== 'right') {
      node.close()
      return
    }
    node.dataset.closing = 'true'
    const targets: Element[] = shell ? [node, shell] : [node]
    gsap.killTweensOf(targets)
    const finish = (): void => {
      delete node.dataset.closing
      if (node.open) node.close()
      gsap.set(targets, { clearProps: 'transform,opacity,visibility' })
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
      // 用 opacity 而不是 autoAlpha：隐藏可见性会让 showModal 刚设置的焦点掉到 body。
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
        data-theme={workbench && placement === 'center' ? 'workbench' : undefined}
        aria-labelledby={titleId}
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
              aria-label="关闭弹窗"
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
