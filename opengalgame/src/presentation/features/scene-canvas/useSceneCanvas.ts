import {
  applyNodeChanges,
  useStoreApi,
  type Connection,
  type EdgeMouseHandler,
  type NodeChange,
  type NodeMouseHandler,
  type OnConnectEnd,
  type OnConnectStart,
  type OnNodeDrag,
  type OnNodesChange
} from '@xyflow/react'
import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react'

import type { ProjectFilesClient } from '@interfaces/project-files/client/ProjectFilesClient'
import { supportsSummary } from '../workbench-session/contentKindLabel'
import { useWorkbenchCommands } from '../workbench-session/workbenchCommandsContext'
import { useWorkbenchSessionStore } from '../workbench-session/workbenchSession.store'
import type {
  SessionCard,
  SessionCardKind,
  SessionRelation
} from '../workbench-session/workbenchSession.types'
import { resolveCardSpacing } from './cardSpacing'
import { canvasCardOpenAction, openCanvasSourceFile } from './openCanvasCard'
import { relationFeedback } from './relationFeedback'
import {
  anchorsFromRelations,
  edgesFromRelations,
  isRelationAnchorId,
  nodesFromCards,
  recordEdgesFromRelations,
  relationAnchorId,
  relationIdOfAnchor
} from './sceneCanvasLayout'
import { useConnectionPreviewMotion } from './useRelationMotion'
import type {
  CanvasClickPreview,
  CanvasEdge,
  CanvasMenuState,
  CanvasNode,
  CanvasNotice,
  InputCardNode
} from './sceneCanvas.types'

function editActionOfCard(card: SessionCard): string | null {
  if (card.kind === 'prompt') return null
  if (card.kind === 'animation' || card.kind === 'effect') return '选择预设'
  if (!supportsSummary(card)) return '编辑标题'
  return card.kind === 'document' ? '编辑标题和简介' : '编辑标题和用途说明'
}

function pointerOf(event: MouseEvent | TouchEvent): { x: number; y: number } | null {
  if ('clientX' in event) return { x: event.clientX, y: event.clientY }
  const touch = event.touches[0] ?? event.changedTouches[0]
  return touch ? { x: touch.clientX, y: touch.clientY } : null
}

type RelationReject = {
  key: number
  relationId: string | null
  cardId: string | null
}

export type SceneCanvasState = {
  nodes: CanvasNode[]
  edges: CanvasEdge[]
  menu: CanvasMenuState
  editingCard: SessionCard | null
  relation: SessionRelation | null
  notice: CanvasNotice | null
  rejectedRelationId: string | null
  rejectedCardId: string | null
  clickPreview: CanvasClickPreview | null
  isConnecting: boolean
  connectingFromCardId: string | null
  connectingFromKind: SessionCardKind | null
  onNodesChange: OnNodesChange<CanvasNode>
  onNodeClick: NodeMouseHandler<CanvasNode>
  onNodeDoubleClick: NodeMouseHandler<CanvasNode>
  onNodeDragStart: OnNodeDrag<CanvasNode>
  onNodeDragStop: OnNodeDrag<CanvasNode>
  onNodeContextMenu: NodeMouseHandler<CanvasNode>
  onPaneClick: () => void
  onEdgeClick: EdgeMouseHandler<CanvasEdge>
  onConnect: (connection: Connection) => void
  /**
   * 低缩放记录装载：按命中仲裁算出的锚点直接走应用层连接动作。
   * 返回 false 表示当前没有待连接来源卡，调用方应保持原有行为。
   */
  attachRecordToAnchor: (relationId: string) => boolean
  onConnectStart: OnConnectStart
  onConnectEnd: OnConnectEnd
  onClickConnectStart: OnConnectStart
  onClickConnectEnd: OnConnectEnd
  cancelConnection: () => void
  closeMenu: () => void
  openEdit: (cardId: string) => void
  closeEdit: () => void
  openRelation: (relationId: string) => void
  closeRelation: () => void
  detachRecord: (relationId: string) => void
  announce: (text: string, tone?: CanvasNotice['tone']) => void
  beginLayoutInteract: () => void
  commitCardLayout: (
    cardId: string,
    layout: { x: number; y: number; width: number; height: number }
  ) => void
}

export function useSceneCanvas(
  viewportRef: RefObject<HTMLDivElement | null>,
  client: ProjectFilesClient
): SceneCanvasState {
  const commands = useWorkbenchCommands()
  const flowStore = useStoreApi()
  const cards = useWorkbenchSessionStore((state) => state.cards)
  const relations = useWorkbenchSessionStore((state) => state.relations)
  const [menu, setMenu] = useState<CanvasMenuState>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [relationId, setRelationId] = useState<string | null>(null)
  const [notice, setNotice] = useState<CanvasNotice | null>(null)
  const [nodes, setNodes] = useState<InputCardNode[]>(() => nodesFromCards(cards))
  const [connectingFromCardId, setConnectingFromCardId] = useState<string | null>(null)
  const [clickPreview, setClickPreview] = useState<CanvasClickPreview | null>(null)
  const [reject, setReject] = useState<RelationReject | null>(null)
  const interacting = useRef(false)
  const noticeSequence = useRef(0)
  const rejectSequence = useRef(0)
  const isConnecting = connectingFromCardId !== null
  const rejectedRelationId = reject?.relationId ?? null

  useEffect(() => {
    if (interacting.current) return
    setNodes((current) => {
      const previous = new Map(current.map((node) => [node.id, node]))
      return nodesFromCards(cards).map((node) => {
        const old = previous.get(node.id)
        return old ? { ...node, measured: old.measured, selected: false, dragging: false } : node
      })
    })
  }, [cards])

  const anchors = useMemo(
    () =>
      anchorsFromRelations(cards, relations, nodes).map((anchor) => ({
        ...anchor,
        data: {
          ...anchor.data,
          rejected: anchor.data.relationId === rejectedRelationId
        }
      })),
    [cards, relations, nodes, rejectedRelationId]
  )
  const allNodes = useMemo<CanvasNode[]>(() => [...nodes, ...anchors], [nodes, anchors])
  const associationEdges = useMemo(
    () =>
      edgesFromRelations(cards, relations).flatMap((edge) =>
        edge.data
          ? [
              {
                ...edge,
                data: {
                  ...edge.data,
                  active: edge.data.relationId === relationId,
                  rejected: edge.data.relationId === rejectedRelationId
                }
              }
            ]
          : []
      ),
    [cards, relations, relationId, rejectedRelationId]
  )
  const recordEdges = useMemo(
    () => recordEdgesFromRelations(cards, relations, anchors),
    [cards, relations, anchors]
  )
  const allEdges = useMemo<CanvasEdge[]>(
    () => [...associationEdges, ...recordEdges],
    [associationEdges, recordEdges]
  )

  const announce = useCallback((text: string, tone: CanvasNotice['tone'] = 'info') => {
    noticeSequence.current += 1
    setNotice({ key: noticeSequence.current, text, tone })
  }, [])

  useEffect(() => {
    if (!notice) return
    const currentKey = notice.key
    const timer = window.setTimeout(() => {
      setNotice((value) => (value && value.key === currentKey ? null : value))
    }, 3400)
    return () => window.clearTimeout(timer)
  }, [notice])

  useEffect(() => {
    if (!reject) return
    const currentKey = reject.key
    const timer = window.setTimeout(() => {
      setReject((value) => (value && value.key === currentKey ? null : value))
    }, 900)
    return () => window.clearTimeout(timer)
  }, [reject])

  const rejectConnection = useCallback((relationId: string | null, cardId: string | null) => {
    rejectSequence.current += 1
    setReject({ key: rejectSequence.current, relationId, cardId })
  }, [])

  useConnectionPreviewMotion(viewportRef, isConnecting)

  useEffect(() => {
    if (!relationId) return
    if (relations.some((relation) => relation.relationId === relationId)) return
    setRelationId(null)
  }, [relationId, relations])

  const finishConnection = useCallback(() => {
    flowStore.getState().cancelConnection()
    flowStore.setState({ connectionClickStartHandle: null })
    setConnectingFromCardId(null)
    setClickPreview(null)
  }, [flowStore])

  useEffect(() => {
    if (!clickPreview) return
    const move = (event: PointerEvent): void => {
      const root = viewportRef.current
      if (!root) return
      const rect = root.getBoundingClientRect()
      setClickPreview((current) =>
        current
          ? { ...current, to: { x: event.clientX - rect.left, y: event.clientY - rect.top } }
          : current
      )
    }
    window.addEventListener('pointermove', move)
    return () => window.removeEventListener('pointermove', move)
  }, [clickPreview, viewportRef])

  const beginClickPreview = useCallback(
    (event: MouseEvent | TouchEvent, nodeId: string) => {
      setConnectingFromCardId(nodeId)
      const target = event.target
      const handle =
        target instanceof Element ? target.closest<HTMLElement>('[data-handleid]') : null
      const root = viewportRef.current
      const point = pointerOf(event)
      if (!handle || !root || !point) {
        setClickPreview(null)
        return
      }
      const handleRect = handle.getBoundingClientRect()
      const rootRect = root.getBoundingClientRect()
      setClickPreview({
        from: {
          x: handleRect.left + handleRect.width / 2 - rootRect.left,
          y: handleRect.top + handleRect.height / 2 - rootRect.top
        },
        to: { x: point.x - rootRect.left, y: point.y - rootRect.top }
      })
    },
    [viewportRef]
  )

  const onConnectStart = useCallback<OnConnectStart>((_event, params) => {
    if (!params.nodeId) return
    setConnectingFromCardId(params.nodeId)
    setClickPreview(null)
  }, [])

  const onClickConnectStart = useCallback<OnConnectStart>(
    (event, params) => {
      if (!params.nodeId) return
      beginClickPreview(event, params.nodeId)
    },
    [beginClickPreview]
  )

  const cancelConnection = useCallback(() => {
    finishConnection()
  }, [finishConnection])

  const onConnectEnd = useCallback<OnConnectEnd>(() => {
    finishConnection()
  }, [finishConnection])

  const onClickConnectEnd = useCallback<OnConnectEnd>(() => {
    finishConnection()
  }, [finishConnection])

  const onConnect = useCallback(
    (connection: Connection) => {
      const state = useWorkbenchSessionStore.getState()
      const anchorRelationId = relationIdOfAnchor(connection.target)
      if (anchorRelationId) {
        const sourceCard = state.cards.find((card) => card.cardId === connection.source)
        if (!sourceCard) {
          relationFeedback.recordAttachFailed()
          finishConnection()
          return
        }
        if (sourceCard.kind !== 'document' && sourceCard.kind !== 'prompt') {
          rejectConnection(anchorRelationId, sourceCard.cardId)
          relationFeedback.recordKindRejected()
          finishConnection()
          return
        }
        const usedByAnother = state.relations.some(
          (relation) =>
            relation.relationId !== anchorRelationId && relation.recordCardId === sourceCard.cardId
        )
        if (sourceCard.kind === 'prompt' && usedByAnother) {
          rejectConnection(anchorRelationId, sourceCard.cardId)
          relationFeedback.recordInUseRejected()
          finishConnection()
          return
        }
        if (!state.relations.some((relation) => relation.relationId === anchorRelationId)) {
          relationFeedback.recordAttachFailed()
          finishConnection()
          return
        }
        void commands.attachRelationRecord(anchorRelationId, sourceCard.cardId).then((applied) => {
          if (applied === 'applied') relationFeedback.recordAttached()
          else if (applied === 'failed') {
            rejectConnection(anchorRelationId, sourceCard.cardId)
            relationFeedback.recordAttachFailed()
          }
        })
        finishConnection()
        return
      }

      if (connection.source === connection.target) {
        rejectConnection(null, connection.source)
        relationFeedback.connectSelfRejected()
        finishConnection()
        return
      }
      const duplicate = state.relations.find(
        (relation) =>
          (relation.fromCardId === connection.source && relation.toCardId === connection.target) ||
          (relation.fromCardId === connection.target && relation.toCardId === connection.source)
      )
      if (duplicate) {
        rejectConnection(duplicate.relationId, connection.source)
        relationFeedback.connectDuplicateRejected()
        finishConnection()
        return
      }
      void commands.connectCards(connection.source, connection.target).then((applied) => {
        if (applied === 'applied') {
          relationFeedback.connected()
        } else if (applied === 'failed') {
          rejectConnection(null, connection.source)
          relationFeedback.connectFailed()
        }
      })
      finishConnection()
    },
    [commands, finishConnection, rejectConnection]
  )

  // 低缩放记录装载：React Flow 的 click-connect 第二步会用 click 坐标 elementFromPoint
  // 重新解析目标 handle，多个记录 handle 叠压时会装到上层锚点；这里按命中仲裁结果直接
  // 走应用层连接动作，复用 onConnect 的校验、反馈与 finishConnection 清理。
  const attachRecordToAnchor = useCallback(
    (relationId: string): boolean => {
      if (!connectingFromCardId) return false
      onConnect({
        source: connectingFromCardId,
        sourceHandle: null,
        target: relationAnchorId(relationId),
        targetHandle: 'record'
      })
      return true
    },
    [connectingFromCardId, onConnect]
  )

  const onNodesChange = useCallback<OnNodesChange<CanvasNode>>((changes) => {
    const baseChanges = changes.filter(
      (change) => 'id' in change && !isRelationAnchorId(change.id)
    ) as NodeChange<InputCardNode>[]
    setNodes((current) => applyNodeChanges(baseChanges, current))
  }, [])

  const onNodeClick = useCallback<NodeMouseHandler<CanvasNode>>(
    (event, node) => {
      if (node.type !== 'inputCard') return
      event.stopPropagation()
      setMenu(null)
      commands.selectCard(node.id)
    },
    [commands]
  )

  const onNodeDoubleClick = useCallback<NodeMouseHandler<CanvasNode>>(
    (event, node) => {
      if (node.type !== 'inputCard') return
      const card = useWorkbenchSessionStore.getState().cards.find((item) => item.cardId === node.id)
      if (!card) return
      const action = canvasCardOpenAction(card, event.target, connectingFromCardId !== null)
      if (!action) return
      event.stopPropagation()
      setMenu(null)
      commands.selectCard(node.id)
      if (action.kind === 'document') {
        commands.openDocumentLayer(action.cardId)
        return
      }
      void openCanvasSourceFile(client, action.request)
    },
    [client, commands, connectingFromCardId]
  )

  const onNodeDragStart = useCallback<OnNodeDrag<CanvasNode>>(
    (_event, node) => {
      if (node.type !== 'inputCard') return
      interacting.current = true
      setMenu(null)
      commands.selectCard(node.id)
    },
    [commands]
  )

  const onNodeDragStop = useCallback<OnNodeDrag<CanvasNode>>(
    (_event, node, dragged) => {
      interacting.current = false
      const targets = dragged.filter((item) => item.type === 'inputCard')
      const moved = targets.length > 0 ? targets : node.type === 'inputCard' ? [node] : []
      if (moved.length === 0) return
      const draggedPositions = new Map(
        moved.map((item) => [
          item.id,
          { x: Math.round(item.position.x), y: Math.round(item.position.y) }
        ])
      )
      const cards = useWorkbenchSessionStore.getState().cards
      const projected = cards.map((card) => {
        const position = draggedPositions.get(card.cardId)
        return position ? { ...card, layout: { ...card.layout, ...position } } : card
      })
      const moves = new Map<string, { cardId: string; x: number; y: number }>()
      for (const item of moved) {
        moves.set(item.id, {
          cardId: item.id,
          x: Math.round(item.position.x),
          y: Math.round(item.position.y)
        })
      }
      // 与拖拽位移合并成一次 moveCards：一次 revision、一条撤销记录。
      for (const move of resolveCardSpacing(projected)) moves.set(move.cardId, move)
      commands.moveCards([...moves.values()])
    },
    [commands]
  )

  const onNodeContextMenu = useCallback<NodeMouseHandler<CanvasNode>>(
    (event, node) => {
      if (node.type !== 'inputCard') return
      event.preventDefault()
      const card = useWorkbenchSessionStore.getState().cards.find((item) => item.cardId === node.id)
      commands.selectCard(node.id)
      setMenu({
        x: Math.max(12, Math.min(event.clientX, window.innerWidth - 232)),
        y: Math.max(12, Math.min(event.clientY, window.innerHeight - 196)),
        cardId: node.id,
        editLabel: card ? editActionOfCard(card) : null
      })
    },
    [commands]
  )

  const onPaneClick = useCallback(() => {
    setMenu(null)
    finishConnection()
    commands.selectCard(null)
  }, [commands, finishConnection])

  const onEdgeClick = useCallback<EdgeMouseHandler<CanvasEdge>>(
    (event, edge) => {
      if (edge.type !== 'sessionAssociation' || connectingFromCardId) return
      event.stopPropagation()
      setMenu(null)
      setRelationId(edge.data?.relationId ?? edge.id)
    },
    [connectingFromCardId]
  )

  const menuCard = menu ? cards.find((card) => card.cardId === menu.cardId) : undefined
  const editingCandidate = editingId
    ? (cards.find((card) => card.cardId === editingId) ?? null)
    : null
  const editingCard =
    editingCandidate && editingCandidate.kind !== 'prompt' ? editingCandidate : null
  const relation = relationId
    ? (relations.find((item) => item.relationId === relationId) ?? null)
    : null
  const connectingCard = connectingFromCardId
    ? cards.find((card) => card.cardId === connectingFromCardId)
    : undefined

  useEffect(() => {
    if (!editingId && !relationId) return
    const guard = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') return
      if ((event.ctrlKey || event.metaKey) && ['z', 'y'].includes(event.key.toLowerCase())) {
        event.stopImmediatePropagation()
        return
      }
      if (event.key === 'Delete') event.stopImmediatePropagation()
    }
    window.addEventListener('keydown', guard, true)
    return () => window.removeEventListener('keydown', guard, true)
  }, [editingId, relationId])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      if (menu) {
        event.preventDefault()
        setMenu(null)
        return
      }
      if (editingId || relationId) return
      if (!isConnecting) return
      event.preventDefault()
      finishConnection()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [editingId, finishConnection, isConnecting, menu, relationId])

  return {
    nodes: allNodes,
    edges: allEdges,
    menu: menu && menuCard ? menu : null,
    editingCard,
    relation,
    notice,
    rejectedRelationId,
    rejectedCardId: reject?.cardId ?? null,
    clickPreview,
    isConnecting,
    connectingFromCardId,
    connectingFromKind: connectingCard?.kind ?? null,
    onNodesChange,
    onNodeClick,
    onNodeDoubleClick,
    onNodeDragStart,
    onNodeDragStop,
    onNodeContextMenu,
    onPaneClick,
    onEdgeClick,
    onConnect,
    attachRecordToAnchor,
    onConnectStart,
    onConnectEnd,
    onClickConnectStart,
    onClickConnectEnd,
    cancelConnection,
    closeMenu: () => setMenu(null),
    openEdit: (cardId) => {
      const card = cards.find((item) => item.cardId === cardId)
      if (!card || card.kind === 'prompt') return
      setMenu(null)
      setEditingId(cardId)
    },
    closeEdit: () => setEditingId(null),
    openRelation: (id) => {
      setMenu(null)
      setRelationId(id)
    },
    closeRelation: () => setRelationId(null),
    detachRecord: (id) => {
      void commands.detachRelationRecord(id).then((applied) => {
        if (applied === 'applied') {
          relationFeedback.recordDetached()
        } else if (applied === 'failed') {
          rejectConnection(id, null)
          relationFeedback.recordDetachFailed()
        }
      })
    },
    announce,
    beginLayoutInteract: () => {
      interacting.current = true
    },
    commitCardLayout: (cardId, layout) => {
      interacting.current = false
      commands.resizeCard(cardId, layout)
    }
  }
}
