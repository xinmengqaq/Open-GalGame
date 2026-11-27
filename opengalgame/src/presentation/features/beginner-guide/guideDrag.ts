import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent
} from 'react'

export type GuideOverlayLayout = 'default' | 'preview'

export type GuidePoint = {
  left: number
  top: number
}

export type PlacedGuidePoint = GuidePoint & { layout: GuideOverlayLayout }

const VIEWPORT_EDGE = 12
const DRAG_THRESHOLD = 3

export function clampGuidePosition(left: number, top: number, node: HTMLElement): GuidePoint {
  const width = node.offsetWidth
  const height = node.offsetHeight
  const maxLeft = Math.max(VIEWPORT_EDGE, window.innerWidth - width - VIEWPORT_EDGE)
  const maxTop = Math.max(VIEWPORT_EDGE, window.innerHeight - height - VIEWPORT_EDGE)
  return {
    left: Math.min(Math.max(VIEWPORT_EDGE, left), maxLeft),
    top: Math.min(Math.max(VIEWPORT_EDGE, top), maxTop)
  }
}

type DragSession = {
  pointerId: number
  startX: number
  startY: number
  left: number
  top: number
  moved: boolean
}

export interface GuideDrag {
  placedPosition: PlacedGuidePoint | null
  dragging: boolean
  style: CSSProperties | undefined
  start(event: PointerEvent<HTMLElement>, node: HTMLElement | null): void
  consumeClick(): boolean
  reclamp(node: HTMLElement | null): void
}

/** 教程浮层共用同一套拖动和边界规则；位置只保留在当前窗口。 */
export function useGuideDrag(layout: GuideOverlayLayout): GuideDrag {
  const [position, setPosition] = useState<PlacedGuidePoint | null>(null)
  const [dragging, setDragging] = useState(false)
  const session = useRef<DragSession | null>(null)
  const suppressedClick = useRef(false)
  const cleanup = useRef<(() => void) | null>(null)
  const placedPosition = position?.layout === layout ? position : null

  const end = useCallback((): void => {
    const drag = session.current
    session.current = null
    cleanup.current?.()
    cleanup.current = null
    setDragging(false)
    if (drag?.moved) {
      suppressedClick.current = true
      window.setTimeout(() => {
        suppressedClick.current = false
      }, 0)
    }
  }, [])

  const start = useCallback(
    (event: PointerEvent<HTMLElement>, node: HTMLElement | null): void => {
      if (event.button !== 0 || !node) return
      cleanup.current?.()
      const rect = node.getBoundingClientRect()
      session.current = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        left: rect.left,
        top: rect.top,
        moved: false
      }
      const handleMove = (next: globalThis.PointerEvent): void => {
        const drag = session.current
        if (!drag || drag.pointerId !== next.pointerId) return
        if (!drag.moved) {
          if (
            Math.abs(next.clientX - drag.startX) < DRAG_THRESHOLD &&
            Math.abs(next.clientY - drag.startY) < DRAG_THRESHOLD
          ) {
            return
          }
          drag.moved = true
          setDragging(true)
        }
        setPosition({
          ...clampGuidePosition(
            drag.left + next.clientX - drag.startX,
            drag.top + next.clientY - drag.startY,
            node
          ),
          layout
        })
      }
      const handleUp = (next: globalThis.PointerEvent): void => {
        if (session.current?.pointerId !== next.pointerId) return
        end()
      }
      window.addEventListener('pointermove', handleMove)
      window.addEventListener('pointerup', handleUp)
      window.addEventListener('pointercancel', handleUp)
      cleanup.current = () => {
        window.removeEventListener('pointermove', handleMove)
        window.removeEventListener('pointerup', handleUp)
        window.removeEventListener('pointercancel', handleUp)
      }
    },
    [end, layout]
  )

  useEffect(() => () => cleanup.current?.(), [])

  const consumeClick = useCallback((): boolean => {
    const suppressed = suppressedClick.current
    suppressedClick.current = false
    return suppressed
  }, [])

  const reclamp = useCallback(
    (node: HTMLElement | null): void => {
      if (!node) return
      setPosition((current) => {
        if (!current || current.layout !== layout) return current
        const next = clampGuidePosition(current.left, current.top, node)
        return next.left === current.left && next.top === current.top
          ? current
          : { ...next, layout }
      })
    },
    [layout]
  )

  return {
    placedPosition,
    dragging,
    style: placedPosition
      ? {
          left: placedPosition.left,
          top: placedPosition.top,
          right: 'auto',
          bottom: 'auto'
        }
      : undefined,
    start,
    consumeClick,
    reclamp
  }
}
