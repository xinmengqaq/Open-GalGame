import { Handle, NodeResizer, Position, type NodeProps } from '@xyflow/react'
import { clsx } from 'clsx'
import { useContext, useRef, type ReactElement } from 'react'

import { PlusIcon } from '../../components/Icons'
import { CanvasInputCard } from '../scene-input-cards/CanvasInputCard'
import { isPreviewCard, cardTitleText } from '../workbench-session/contentKindLabel'
import { useWorkbenchSessionStore } from '../workbench-session/workbenchSession.store'
import { CanvasNodeContext } from './canvasNodeContext'
import { ConnectionPort, type ConnectionPortState } from './ConnectionPort'
import portStyles from './InputCardNode.module.css'
import styles from './SceneCanvas.module.css'
import type { InputCardNode } from './sceneCanvas.types'
import { useInputCardNodeMotion } from './useInputCardNodeMotion'

interface CardPortProps {
  cardId: string
  side: 'left' | 'right'
  state: ConnectionPortState
  selected: boolean
  label: string
}

/** 卡片侧端口：44px 命中区，可见菱形复用关系层形状，中心落在外框边缘。 */
function CardPort({ cardId, side, state, selected, label }: CardPortProps): ReactElement {
  const left = side === 'left'
  return (
    <Handle
      type="source"
      id={side}
      position={left ? Position.Left : Position.Right}
      isConnectableStart
      isConnectableEnd
      className={clsx(portStyles.port, left ? portStyles.portLeft : portStyles.portRight)}
      data-port-key={`${cardId}:${side}`}
      aria-label={`从${left ? '左' : '右'}侧连接 ${label}`}
      title="拖动或点击，再选另一张卡片"
    >
      <span
        className={portStyles.glyph}
        data-state={state}
        data-selected={selected}
        aria-hidden="true"
      >
        <span className={portStyles.scale}>
          <ConnectionPort state={state} />
        </span>
        {state === 'idle' ? (
          <span className={portStyles.plus}>
            <PlusIcon />
          </span>
        ) : null}
      </span>
    </Handle>
  )
}

/**
 * React Flow 自定义节点：承载输入卡片，并在卡面之外提供两侧连接端口。
 * 选中与悬停由卡片外框表达；这里只补充端口状态与拒绝轮廓，不重复选择态。
 */
export function InputCardNodeView({ id }: NodeProps<InputCardNode>): ReactElement | null {
  const nodeActions = useContext(CanvasNodeContext)
  const rootRef = useRef<HTMLDivElement>(null)
  const card = useWorkbenchSessionStore((state) => state.cards.find((item) => item.cardId === id))
  const selected = useWorkbenchSessionStore((state) => state.selectedCardId === id)
  const rejected = nodeActions.rejectedCardId === id
  const connectingFromHere = nodeActions.isConnecting && nodeActions.connectingFromCardId === id
  const canTarget = nodeActions.isConnecting && !connectingFromHere
  let portState: ConnectionPortState = 'idle'
  if (rejected) portState = 'rejected'
  if (nodeActions.isConnecting) portState = connectingFromHere ? 'active' : 'ready'

  useInputCardNodeMotion({
    root: rootRef,
    connecting: nodeActions.isConnecting,
    rejected
  })

  if (!card) return null
  const preview = isPreviewCard(card.kind)
  const prompt = card.kind === 'prompt'
  const label = cardTitleText(card)

  return (
    <div
      ref={rootRef}
      className={clsx(styles.node, canTarget && styles.nodeTargetReady)}
      data-preview={preview}
      data-fill={preview || prompt}
      data-kind={card.kind}
      data-selected={selected}
      data-connecting={nodeActions.isConnecting}
      data-rejected={rejected}
    >
      <span className={portStyles.rejectAura} data-motion="card-reject-aura" aria-hidden="true" />
      {preview || prompt ? (
        <NodeResizer
          isVisible={selected}
          keepAspectRatio={preview}
          minWidth={preview ? 96 : 240}
          minHeight={preview ? 96 : 120}
          maxWidth={1200}
          maxHeight={1200}
          color="#8d67ab"
          lineClassName={styles.resizeLine}
          handleClassName={styles.resizeHandle}
          onResizeStart={() => nodeActions.beginLayoutInteract()}
          onResizeEnd={(_event, params) => {
            nodeActions.commitCardLayout(id, {
              x: params.x,
              y: params.y,
              width: params.width,
              height: params.height
            })
          }}
        />
      ) : null}
      <div className={styles.nodeBody}>
        <CanvasInputCard
          card={card}
          selected={selected}
          onEditSummary={
            card.kind === 'prompt' ? undefined : () => nodeActions.openEdit(card.cardId)
          }
        />
      </div>
      <CardPort cardId={id} side="left" state={portState} selected={selected} label={label} />
      <CardPort cardId={id} side="right" state={portState} selected={selected} label={label} />
      {canTarget ? (
        <Handle
          type="target"
          id="card"
          position={Position.Left}
          isConnectableStart={false}
          className={styles.cardTarget}
          aria-label={`连接到此卡片 ${label}`}
        />
      ) : null}
    </div>
  )
}
