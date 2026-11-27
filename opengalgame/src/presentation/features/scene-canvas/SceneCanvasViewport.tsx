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
  useState,
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
  const [initialViewport] = useState<Viewport>(() => useWorkbenchSessionStore.getState().viewport)
  const lastLocalViewport = useRef<Viewport | null>(null)
  const redirectedPressRef = useRef<CanvasPoint | null>(null)
  const releasePointRef = useRef<CanvasPoint | null>(null)

  const onMove = useCallback<OnMove>(
    (_event, next) => {
      lastLocalViewport.current = next
      commands.setViewport(next)
    },
    [commands]
  )

  const syncZoomInverse = useCallback(
    (viewport: Viewport) => {
      applyCanvasZoomInverse(surfaceRef.current, viewport.zoom)
    },
    [surfaceRef]
  )

  useOnViewportChange({ onChange: syncZoomInverse })

  const arbitrateCanvasHit = useCallback(
    (event: ReactMouseEvent<HTMLDivElement>) => {
      const root = surfaceRef.current
      if (!root || event.button !== 0) return
      if (event.type === 'mousedown') releasePointRef.current = null
      const point = { x: event.clientX, y: event.clientY }
      if (event.type === 'click') {
        if (!shouldForwardClickAtRedirectedPress(redirectedPressRef.current, point)) return
        redirectedPressRef.current = null
      }
      if (!shouldArbitrateCanvasHit(flow.getViewport().zoom)) return
      const target = event.target
      if (!(target instanceof Element)) return
      const handle = target.closest('.react-flow__handle')
      if (handle && !handle.matches('[data-port-key]')) {
        const anchorNode = target.closest('.react-flow__node-relationAnchor')
        const actualRelationId =
          anchorNode?.querySelector<HTMLElement>('[data-anchor-id]')?.dataset.anchorId
        if (!actualRelationId) return
        const anchors = collectCanvasHitTargets(root).flatMap((item) =>
          item.candidate.kind === 'anchor' ? [item.candidate] : []
        )
        const winner = resolveAnchorContainerTarget(point, anchors, actualRelationId)
        if (!winner || winner.id === actualRelationId) return
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
      if (!actual && isInteractiveCanvasElement(target)) return
      if (actual?.kind === 'anchor') {
        const glyphOf = (id: string): (typeof targets)[number]['candidate'] | undefined =>
          targets.find((item) => item.candidate.kind === 'anchor' && item.candidate.id === id)
            ?.candidate
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

  const noteReleasePoint = useCallback((event: ReactMouseEvent<HTMLDivElement>) => {
    releasePointRef.current = { x: event.clientX, y: event.clientY }
  }, [])

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
      data-content-scope="canvas"
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
        defaultViewport={initialViewport}
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
        <Background
          variant={BackgroundVariant.Dots}
          gap={30}
          size={1}
          color="var(--content-border-strong)"
        />
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
