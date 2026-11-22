import type {
  SceneCanvasArrangementVersion,
  SceneCanvasVersionKeepRequest,
  SceneCanvasVersionSettlement
} from '../models/SceneCanvasSaveFacts'

export interface SceneCanvasWorkVersionGateway {
  keepArrangement(request: SceneCanvasVersionKeepRequest): Promise<SceneCanvasVersionSettlement>

  readSettlement(operationId: string): Promise<SceneCanvasVersionSettlement>

  readArrangementVersion(
    request: Pick<SceneCanvasArrangementVersion, 'projectId' | 'sceneId' | 'canvasId'>
  ): Promise<SceneCanvasArrangementVersion>
}
