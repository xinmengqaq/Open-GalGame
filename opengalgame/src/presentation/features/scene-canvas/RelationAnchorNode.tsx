import { Handle, Position, useUpdateNodeInternals, type NodeProps } from '@xyflow/react'
import { useContext, useEffect, useRef, type CSSProperties, type ReactElement } from 'react'

import { CanvasNodeContext } from './canvasNodeContext'
import { ConnectionPort, type ConnectionPortState } from './ConnectionPort'
import layerStyles from './RelationLayer.module.css'
import { RecordIcon } from './SceneCanvasIcons'
import type { RelationAnchorNode } from './sceneCanvas.types'
import { useRelationLabelMotion } from './useRelationMotion'

/**
 * 关系标签锚点。普通点击编辑特殊关系；连接来自文档或提示词卡时，
 * 标签行内的记录落点接收连接，把卡片装载为这条线的关系记录。
 */
export function RelationAnchorNodeView({ id, data }: NodeProps<RelationAnchorNode>): ReactElement {
  const nodeActions = useContext(CanvasNodeContext)
  const rootRef = useRef<HTMLDivElement>(null)
  const updateNodeInternals = useUpdateNodeInternals()
  const canLoadRecord =
    nodeActions.isConnecting &&
    (nodeActions.connectingFromKind === 'document' || nodeActions.connectingFromKind === 'prompt')
  const active = nodeActions.activeRelationId === data.relationId
  const rejected = Boolean(data.rejected)
  const unnamed = data.labelKind === 'empty'
  let portState: ConnectionPortState = unnamed ? 'unnamed' : 'named'
  if (active) portState = 'active'
  if (canLoadRecord) portState = 'ready'
  if (rejected) portState = 'rejected'

  useRelationLabelMotion({
    root: rootRef,
    signature: `${data.labelKind}|${data.label}|${data.recordCardId ?? ''}`,
    active,
    rejected,
    loadable: canLoadRecord
  })

  // 记录装载会改变标签高度，handle 的实测位置要跟着重新测量；
  // 依赖只放节点身份与记录身份，避免每次渲染都触发测量。
  useEffect(() => {
    updateNodeInternals(id)
  }, [id, updateNodeInternals, data.recordCardId])

  return (
    <div
      ref={rootRef}
      className={layerStyles.anchor}
      style={{ '--label-lift': `${data.labelLift ?? 0}px` } as CSSProperties}
      data-label-kind={data.labelKind}
      data-source-kind={data.sourceKind}
      data-tone={unnamed ? 'unnamed' : 'named'}
      data-condensed={data.condensed || undefined}
      data-loadable={canLoadRecord}
      data-active={active}
      data-rejected={rejected}
    >
      {canLoadRecord ? <span className={layerStyles.dropHint}>装载为关系记录</span> : null}
      <div
        className={layerStyles.labelRow}
        data-motion="relation-label"
        data-relation-id={data.relationId}
      >
        <button
          type="button"
          className={layerStyles.label}
          data-anchor-id={data.relationId}
          aria-label={`编辑特殊关系：${data.label}（${unnamed ? '未命名' : '已命名'}）`}
          aria-expanded={active}
          title="编辑特殊关系"
          onClick={(event) => {
            event.stopPropagation()
            if (!nodeActions.isConnecting) nodeActions.openRelation(data.relationId)
          }}
        >
          <span className={layerStyles.stateMark} data-anchor-dot aria-hidden="true" />
          <span className={layerStyles.labelText}>{data.label}</span>
          {data.recordCardId ? (
            <span
              className={layerStyles.recordMark}
              title={data.recordLabel ?? '已装载关系记录'}
              aria-label="已装载关系记录"
            >
              <RecordIcon />
            </span>
          ) : null}
        </button>
        {data.recordCardId ? (
          <button
            type="button"
            className={layerStyles.recordDetach}
            aria-label="卸下关系记录"
            title="卸下关系记录"
            onClick={(event) => {
              event.stopPropagation()
              nodeActions.detachRecord(data.relationId)
            }}
          >
            ×
          </button>
        ) : null}
        {/* 记录落点留在标签行内：命中区只覆盖可见标签，可装载时才拦截点击。 */}
        <Handle
          type="target"
          id="record"
          position={Position.Top}
          isConnectableStart={false}
          className={layerStyles.anchorHandle}
          aria-label="装载关系记录"
        />
      </div>
      <span className={layerStyles.portAnchor} data-motion="relation-port">
        <ConnectionPort state={portState} />
      </span>
    </div>
  )
}
