import { getBezierPath, type EdgeProps } from '@xyflow/react'
import type { ReactElement } from 'react'

import layerStyles from './RelationLayer.module.css'
import type { RecordEdge } from './sceneCanvas.types'

export function RelationRecordEdge({
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition
}: EdgeProps<RecordEdge>): ReactElement {
  const [path] = getBezierPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition
  })

  return (
    <g className={layerStyles.recordEdgeLayer} aria-hidden="true">
      <path d={path} className={layerStyles.recordEdgeLine} vectorEffect="non-scaling-stroke" />
      <circle
        cx={sourceX}
        cy={sourceY}
        r="2.4"
        className={layerStyles.recordEdgeSource}
        vectorEffect="non-scaling-stroke"
      />
      <rect
        x={targetX - 3.8}
        y={targetY - 3.8}
        width="7.6"
        height="7.6"
        transform={`rotate(45 ${targetX} ${targetY})`}
        className={layerStyles.recordEdgePin}
        vectorEffect="non-scaling-stroke"
      />
    </g>
  )
}
