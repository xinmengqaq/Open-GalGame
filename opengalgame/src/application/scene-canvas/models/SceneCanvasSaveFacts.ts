import type { SceneCanvasSaveReason } from '../dto/SceneCanvasDTO'
import type { SceneCanvasArrangementVO } from '../vo/SceneCanvasArrangementVO'

export type SceneCanvasVersionKeepRequest = {
  projectId: string
  sceneId: string
  canvasId: string
  reason: SceneCanvasSaveReason
  arrangement: SceneCanvasArrangementVO
  operationId: string
}

export type SceneCanvasVersionSettlement = {
  state: 'kept' | 'uncommitted' | 'failed' | 'unknown'
}

export type SceneCanvasArrangementVersion = {
  projectId: string
  sceneId: string
  canvasId: string
  arrangementVersion: string
}
