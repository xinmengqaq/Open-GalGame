import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'

/** 由壳层测量、子组件只消费的客户区安全区。 */
export type WorkbenchInsetSlot = 'topBar' | 'feedback' | 'bottomDock' | 'modal'

export interface WorkbenchLayoutInsets {
  topBar: number
  feedback: number
  bottomDock: number
  modal: number
}

/** 画布实际可交互矩形相对画布外壳扣除的安全边距。 */
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

/**
 * 反馈层、抽屉等浮层在画布外壳之外；画布只需让出底部 dock 空间。
 * 其余槽位保留给状态模型和模态层消费，不由画布自行读取窗口尺寸。
 */
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

/**
 * 注册需要参与安全区计算的实际节点，并按实际矩形测量。
 * 使用稳定的 registerInset 回调，避免每次渲染注销再注册造成抖动。
 */
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

/** 壳层测量自身宽度，动作栏按实际可用宽度决定图文还是更多菜单。 */
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
