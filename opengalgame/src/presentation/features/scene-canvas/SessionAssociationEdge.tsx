import { getBezierPath, type EdgeProps } from '@xyflow/react'
import { useRef, type ReactElement } from 'react'

import layerStyles from './RelationLayer.module.css'
import type { SessionEdge } from './sceneCanvas.types'
import { useRelationEdgeMotion } from './useRelationMotion'

/**
 * 关联线只画路径；关系名称由路径中点的锚点节点显示。
 * 线色、虚线与端点形状共同表达已命名、未命名、选中和拒绝，不依赖单一颜色。
 */
export function SessionAssociationEdge({
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  data
}: EdgeProps<SessionEdge>): ReactElement {
  const rootRef = useRef<SVGGElement>(null)
  const [path] = getBezierPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition
  })
  const pending = data?.pending ?? true
  const active = data?.active ?? false
  const rejected = data?.rejected ?? false
  const tone = pending ? 'unnamed' : 'named'

  useRelationEdgeMotion({ root: rootRef, pending, active, rejected })

  return (
    <g
      ref={rootRef}
      className={layerStyles.edgeLayer}
      data-tone={tone}
      data-active={active}
      data-rejected={rejected}
      aria-hidden="true"
    >
      <path
        d={path}
        className={layerStyles.edgeUnderlay}
        data-motion="relation-edge-glow"
        vectorEffect="non-scaling-stroke"
      />
      <path
        d={path}
        className={layerStyles.edgeLine}
        data-motion="relation-edge-line"
        vectorEffect="non-scaling-stroke"
      />
      <circle
        cx={sourceX}
        cy={sourceY}
        r="3.4"
        className={layerStyles.edgeEndpoint}
        vectorEffect="non-scaling-stroke"
      />
      <circle
        cx={targetX}
        cy={targetY}
        r="3.4"
        className={layerStyles.edgeEndpoint}
        vectorEffect="non-scaling-stroke"
      />
      <path d={path} className={layerStyles.edgeHit} vectorEffect="non-scaling-stroke" />
    </g>
  )
}
