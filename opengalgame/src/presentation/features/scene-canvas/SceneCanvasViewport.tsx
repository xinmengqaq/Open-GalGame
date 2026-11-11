import {
  Background,
  BackgroundVariant,
  ConnectionMode,
  ReactFlow,
  useOnViewportChange,
  useReactFlow,
  type Connection,
  type OnMove,
  type Viewport
} from '@xyflow/react'
import {
  useCallback,
  useEffect,
  useRef,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  type ReactElement,
  type RefObject
} from 'react'

import type { ProjectFilesClient } from '@interfaces/project-files/client/ProjectFilesClient'
import type { CanvasSafeArea } from '../../pages/workbench/shell/workbenchLayout'
import { useWorkbenchCommands } from '../workbench-session/workbenchCommandsContext'
import { useWorkbenchSessionStore } from '../workbench-session/workbenchSession.store'
import { InputCardNodeView } from './InputCardNode'
import { RelationAnchorNodeView } from './RelationAnchorNode'
import { RelationRecordEdge } from './RelationRecordEdge'
import { SceneCanvasDropZone } from './SceneCanvasDropZone'
import { SceneCanvasEmptyState } from './SceneCanvasEmptyState'
import { SessionAssociationEdge } from './SessionAssociationEdge'
import { applyCanvasZoomInverse } from './canvasZoomHitArea'
import {
  canvasHitAttributionOf,
  collectCanvasHitTargets,
  forwardCanvasHitEvent,
  isInteractiveCanvasElement
} from './canvasHitTargets'
import {
  correctAnchorConnectTarget,
  pointInAnchorGlyph,
  resolveAnchorContainerTarget,
  resolveCanvasHit,
  shouldArbitrateCanvasHit,
  shouldForwardClickAtRedirectedPress,
  shouldRedirectCanvasHit,
  type CanvasPoint
} from './hitArbitration'
import { useSceneCanvasDragAndDrop } from './useSceneCanvasDragAndDrop'
import { relationAnchorId, relationIdOfAnchor } from './sceneCanvasLayout'
import type { SceneCanvasState } from './useSceneCanvas'
import styles from './SceneCanvas.module.css'
import type { CanvasClickPreview, CanvasEdge, CanvasNode } from './sceneCanvas.types'

const nodeTypes = { inputCard: InputCardNodeView, relationAnchor: RelationAnchorNodeView }
const edgeTypes = { sessionAssociation: SessionAssociationEdge, recordLink: RelationRecordEdge }

interface SceneCanvasViewportProps {
  client: ProjectFilesClient
  surfaceRef: RefObject<HTMLDivElement | null>
  canvas: SceneCanvasState
  safeArea: CanvasSafeArea
  onAddPrompt: () => void
  /** 低缩放记录装载：命中仲裁算出锚点后直接走应用层连接动作，绕开 React Flow 的坐标重解析。 */
  onAttachRecord: (relationId: string) => boolean
}

export function SceneCanvasViewport({
  client,
  surfaceRef,
  canvas,
  safeArea,
  onAddPrompt,
  onAttachRecord
}: SceneCanvasViewportProps): ReactElement {
  const commands = useWorkbenchCommands()
  const flow = useReactFlow<CanvasNode, CanvasEdge>()
  const drop = useSceneCanvasDragAndDrop(client)
  const cards = useWorkbenchSessionStore((state) => state.cards)
  const storedViewport = useWorkbenchSessionStore((state) => state.viewport)
  const initialViewport = useRef<Viewport>(useWorkbenchSessionStore.getState().viewport)
  const lastLocalViewport = useRef<Viewport | null>(null)
  // 最近一次被重定向转发的 mousedown 坐标：只用于判定随后的 click 是否同一次手势。
  const redirectedPressRef = useRef<CanvasPoint | null>(null)
  // 最近一次松手坐标：drag 的 target 在 pointermove 期由库的 elementFromPoint 决定，
  // 松手后用它重新裁决记录装载归属（低缩放下叠压的 handle 会把 target 判给相邻锚点）。
  const releasePointRef = useRef<CanvasPoint | null>(null)

  const onMove = useCallback<OnMove>(
    (_event, next) => {
      lastLocalViewport.current = next
      commands.setViewport(next)
    },
    [commands]
  )

  // 低缩放命中补偿：视口变化只改画布祖先上的 CSS 变量，不触发节点重渲染。
  const syncZoomInverse = useCallback(
    (viewport: Viewport) => {
      applyCanvasZoomInverse(surfaceRef.current, viewport.zoom)
    },
    [surfaceRef]
  )

  useOnViewportChange({ onChange: syncZoomInverse })

  // 低缩放命中仲裁：端口与锚点的 DOM 命中区互相叠压，按最近的可见中心重新归属；
  // 归属不一致时拦住原事件，向解析出的元素转发同坐标事件，保住 React Flow 的连线起手。
  const arbitrateCanvasHit = useCallback(
    (event: ReactMouseEvent<HTMLDivElement>) => {
      const root = surfaceRef.current
      if (!root || event.button !== 0) return
      // 新手势开始：清掉上一次 drag 的松手点，避免旧坐标参与随后的 onConnect 纠正。
      if (event.type === 'mousedown') releasePointRef.current = null
      const point = { x: event.clientX, y: event.clientY }
      if (event.type === 'click') {
        // drag 完成边后 mouseup 已清掉 click 连线起点，浏览器还会补发一次 target 为公共
        // 祖先的 click；只有它与一次被重定向的 mousedown 同点（同一手势）时才继续，
        // 否则放行，避免把补发的 click 转发给端口、被 Handle.onClick 当成新的 click
        // 连线起点，留下 ct=6 的待连接态。
        if (!shouldForwardClickAtRedirectedPress(redirectedPressRef.current, point)) return
        redirectedPressRef.current = null
      }
      if (!shouldArbitrateCanvasHit(flow.getViewport().zoom)) return
      const target = event.target
      if (!(target instanceof Element)) return
      const handle = target.closest('.react-flow__handle')
      if (handle && !handle.matches('[data-port-key]')) {
        // 卡片目标端口仍直接放行，保住 click 连线第二步；关系锚点的记录装载 handle
        // 在低缩放下会互相叠压，DOM 层叠决定事件落到哪个锚点，需要按锚点容器重算归属。
        const anchorNode = target.closest('.react-flow__node-relationAnchor')
        const actualRelationId =
          anchorNode?.querySelector<HTMLElement>('[data-anchor-id]')?.dataset.anchorId
        if (!actualRelationId) return
        const anchors = collectCanvasHitTargets(root).flatMap((item) =>
          item.candidate.kind === 'anchor' ? [item.candidate] : []
        )
        const winner = resolveAnchorContainerTarget(point, anchors, actualRelationId)
        if (!winner || winner.id === actualRelationId) return
        // click 装载走应用层动作：React Flow 的 click-connect 第二步会用 click 坐标
        // elementFromPoint 重解析目标 handle，低缩放下叠压的宽 handle 会把转发给 winner
        // 的 click 重新解析成上层锚点；这里直接按 winner 装载，绕开坐标重解析。
        if (event.type === 'click' && onAttachRecord(winner.id)) {
          event.stopPropagation()
          event.preventDefault()
          redirectedPressRef.current = null
          return
        }
        const winnerHandle = winner.recordHandleElement
        if (!(winnerHandle instanceof HTMLElement)) return
        if (event.type === 'mousedown') redirectedPressRef.current = point
        event.stopPropagation()
        event.preventDefault()
        forwardCanvasHitEvent(event.nativeEvent, winnerHandle)
        return
      }
      const targets = collectCanvasHitTargets(root)
      if (targets.length === 0) return
      const resolved = resolveCanvasHit(
        point,
        targets.map((item) => item.candidate)
      )
      if (!resolved) return
      const actual = canvasHitAttributionOf(target)
      if (actual && actual.kind === resolved.kind && actual.id === resolved.id) return
      // 没有落在端口/锚点上时，不抢卡片内按钮、链接等既有交互。
      if (!actual && isInteractiveCanvasElement(target)) return
      // 锚点一侧按光点本体纠偏：解析结果也是锚点时只放行落在其自身光点上的点击，展开的标签
      // 文字仍由它自己的锚点元素接收；解析结果是端口时再交给 shouldRedirectCanvasHit 按 bullseye
      // 与最近中心裁决，避免误开邻近关系。
      if (actual?.kind === 'anchor') {
        const glyphOf = (id: string) =>
          targets.find(
            (item) => item.candidate.kind === 'anchor' && item.candidate.id === id
          )?.candidate
        if (resolved.kind === 'anchor') {
          const resolvedGlyph = glyphOf(resolved.id)
          if (
            !resolvedGlyph ||
            resolvedGlyph.kind !== 'anchor' ||
            !pointInAnchorGlyph(point, resolvedGlyph)
          ) {
            return
          }
        } else {
          // 实际落在锚点元素上，但解析结果是端口：bullseye 或端口中心更近才转派，标签区不参与判定。
          const actualGlyph = glyphOf(actual.id)
          if (
            !actualGlyph ||
            actualGlyph.kind !== 'anchor' ||
            !shouldRedirectCanvasHit(point, resolved, actualGlyph)
          ) {
            return
          }
        }
      }
      const hit = targets.find(
        (item) => item.candidate.kind === resolved.kind && item.candidate.id === resolved.id
      )
      if (!hit) return
      if (event.type === 'mousedown') redirectedPressRef.current = point
      event.stopPropagation()
      event.preventDefault()
      forwardCanvasHitEvent(event.nativeEvent, hit.element)
    },
    [flow, onAttachRecord, surfaceRef]
  )

  // React 根 capture 的 mouseup 早于 React Flow 挂在 document（冒泡）上的松手监听，
  // 先记录松手坐标，onConnect 触发时它已就绪。
  const noteReleasePoint = useCallback((event: ReactMouseEvent<HTMLDivElement>) => {
    releasePointRef.current = { x: event.clientX, y: event.clientY }
  }, [])

  // drag 装载纠正：React Flow 的拖拽 target 由 pointermove 期的 elementFromPoint 决定，
  // 低缩放下 2937 的宽 handle 会盖住 5985 的 handle，松手时只消费最后一次结果。
  // 这里按锚点容器重新裁决，不一致时改投应用层 onConnect，绕开库的坐标重解析。
  const handleConnect = useCallback(
    (connection: Connection) => {
      const root = surfaceRef.current
      const point = releasePointRef.current
      releasePointRef.current = null
      const actualRelationId = relationIdOfAnchor(connection.target)
      if (root && point && actualRelationId) {
        const anchors = collectCanvasHitTargets(root).flatMap((item) =>
          item.candidate.kind === 'anchor' ? [item.candidate] : []
        )
        const correctedId = correctAnchorConnectTarget(
          point,
          actualRelationId,
          anchors,
          flow.getViewport().zoom
        )
        if (correctedId) {
          canvas.onConnect({
            ...connection,
            target: relationAnchorId(correctedId),
            targetHandle: 'record'
          })
          return
        }
      }
      canvas.onConnect(connection)
    },
    [canvas, flow, surfaceRef]
  )

  useEffect(() => {
    applyCanvasZoomInverse(surfaceRef.current, flow.getViewport().zoom)
  }, [flow, surfaceRef])

  useEffect(() => {
    const current = flow.getViewport()
    if (
      Math.abs(current.x - storedViewport.x) < 0.75 &&
      Math.abs(current.y - storedViewport.y) < 0.75 &&
      Math.abs(current.zoom - storedViewport.zoom) < 0.0005
    ) {
      return
    }
    const local = lastLocalViewport.current
    if (
      local &&
      Math.abs(local.x - storedViewport.x) < 0.75 &&
      Math.abs(local.y - storedViewport.y) < 0.75 &&
      Math.abs(local.zoom - storedViewport.zoom) < 0.0005
    ) {
      return
    }
    void flow.setViewport(
      { x: storedViewport.x, y: storedViewport.y, zoom: storedViewport.zoom },
      { duration: 0 }
    )
  }, [flow, storedViewport.x, storedViewport.y, storedViewport.zoom])

  return (
    <div
      className={styles.viewport}
      ref={surfaceRef}
      data-testid="scene-canvas"
      onMouseUpCapture={noteReleasePoint}
      style={
        {
          '--canvas-safe-top': `${safeArea.top}px`,
          '--canvas-safe-right': `${safeArea.right}px`,
          '--canvas-safe-bottom': `${safeArea.bottom}px`,
          '--canvas-safe-left': `${safeArea.left}px`
        } as CSSProperties
      }
    >
      <ReactFlow<CanvasNode, CanvasEdge>
        nodes={canvas.nodes}
        edges={canvas.edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        defaultViewport={initialViewport.current}
        minZoom={0.32}
        maxZoom={1.8}
        nodesDraggable
        nodesConnectable
        nodesFocusable={false}
        edgesFocusable={false}
        elementsSelectable={false}
        deleteKeyCode={null}
        connectionMode={ConnectionMode.Loose}
        connectionRadius={34}
        connectionDragThreshold={4}
        connectOnClick
        panOnScroll
        selectionOnDrag={false}
        zoomOnDoubleClick={false}
        onMove={onMove}
        onMouseDownCapture={arbitrateCanvasHit}
        onClickCapture={arbitrateCanvasHit}
        onNodesChange={canvas.onNodesChange}
        onNodeClick={canvas.onNodeClick}
        onNodeDoubleClick={canvas.onNodeDoubleClick}
        onNodeDragStart={canvas.onNodeDragStart}
        onNodeDragStop={canvas.onNodeDragStop}
        onNodeContextMenu={canvas.onNodeContextMenu}
        onPaneClick={canvas.onPaneClick}
        onEdgeClick={canvas.onEdgeClick}
        onConnect={handleConnect}
        onConnectStart={canvas.onConnectStart}
        onConnectEnd={canvas.onConnectEnd}
        onClickConnectStart={canvas.onClickConnectStart}
        onClickConnectEnd={canvas.onClickConnectEnd}
        onDragOver={drop.onDragOver}
        onDrop={drop.onDrop}
        onDragLeave={drop.onDragLeave}
        proOptions={{ hideAttribution: false }}
        className={styles.flow}
      >
        <Background variant={BackgroundVariant.Dots} gap={30} size={1} color="#b9a6cf" />
      </ReactFlow>
      {cards.length === 0 ? <SceneCanvasEmptyState onAddPrompt={onAddPrompt} /> : null}
      <SceneCanvasDropZone active={drop.draggingOver} />
      {canvas.clickPreview ? <ConnectionPreview preview={canvas.clickPreview} /> : null}
    </div>
  )
}

function ConnectionPreview({ preview }: { preview: CanvasClickPreview }): ReactElement {
  const bend = Math.max(44, Math.abs(preview.to.x - preview.from.x) * 0.38)
  const path = `M ${preview.from.x} ${preview.from.y} C ${preview.from.x + bend} ${
    preview.from.y
  }, ${preview.to.x - bend} ${preview.to.y}, ${preview.to.x} ${preview.to.y}`
  return (
    <svg className={styles.connectionPreview} aria-hidden="true">
      <path className={styles.connectionPreviewGlow} d={path} />
      <path className={styles.connectionPreviewLine} d={path} />
      <circle cx={preview.to.x} cy={preview.to.y} r="4.5" className={styles.connectionPreviewDot} />
    </svg>
  )
}
