import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'

export type WorkbenchInsetSlot = 'topBar' | 'feedback' | 'bottomDock' | 'modal'

export interface WorkbenchLayoutInsets {
  topBar: number
  feedback: number
  bottomDock: number
  modal: number
}

export interface CanvasSafeArea {
  top: number
  right: number
  bottom: number
  left: number
}

export type RegisterWorkbenchInset = (slot: WorkbenchInsetSlot, node: HTMLElement | null) => void

export const emptyWorkbenchInsets: WorkbenchLayoutInsets = {
  topBar: 0,
  feedback: 0,
  bottomDock: 0,
  modal: 0
}

export function canvasSafeAreaOf(insets: WorkbenchLayoutInsets): CanvasSafeArea {
  return {
    top: 0,
    right: 0,
    bottom: insets.bottomDock,
    left: 0
  }
}

function heightOf(node: HTMLElement | undefined): number {
  return node ? Math.ceil(node.getBoundingClientRect().height) : 0
}

export function useWorkbenchLayoutInsets(): {
  insets: WorkbenchLayoutInsets
  registerInset: RegisterWorkbenchInset
} {
  const nodes = useRef<Partial<Record<WorkbenchInsetSlot, HTMLElement>>>({})
  const observer = useRef<ResizeObserver | null>(null)
  const [insets, setInsets] = useState<WorkbenchLayoutInsets>(emptyWorkbenchInsets)

  const measure = useCallback(() => {
    const next: WorkbenchLayoutInsets = {
      topBar: heightOf(nodes.current.topBar),
      feedback: heightOf(nodes.current.feedback),
      bottomDock: heightOf(nodes.current.bottomDock),
      modal: heightOf(nodes.current.modal)
    }
    setInsets((current) =>
      current.topBar === next.topBar &&
      current.feedback === next.feedback &&
      current.bottomDock === next.bottomDock &&
      current.modal === next.modal
        ? current
        : next
    )
  }, [])

  const registerInset = useCallback<RegisterWorkbenchInset>(
    (slot, node) => {
      const previous = nodes.current[slot]
      if (previous === node) return
      if (!observer.current && typeof ResizeObserver !== 'undefined') {
        observer.current = new ResizeObserver(() => measure())
      }
      if (previous) observer.current?.unobserve(previous)
      if (node) {
        nodes.current[slot] = node
        observer.current?.observe(node)
      } else {
        delete nodes.current[slot]
      }
      measure()
    },
    [measure]
  )

  useEffect(
    () => () => {
      observer.current?.disconnect()
      observer.current = null
    },
    []
  )

  return { insets, registerInset }
}

export function useMeasuredWidth(ref: RefObject<HTMLElement | null>): number {
  const [width, setWidth] = useState(() => (typeof window === 'undefined' ? 0 : window.innerWidth))

  useEffect(() => {
    const node = ref.current
    if (!node || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0]
      if (entry) setWidth(Math.round(entry.contentRect.width))
    })
    observer.observe(node)
    setWidth(Math.round(node.getBoundingClientRect().width))
    return () => observer.disconnect()
  }, [ref])

  return width
}
