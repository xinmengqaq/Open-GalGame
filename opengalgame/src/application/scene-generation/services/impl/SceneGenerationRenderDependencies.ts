import type { SaveSceneCanvasArrangementDTO } from '@application/scene-canvas/dto/SceneCanvasDTO'
import type { SceneCanvasArrangementVO } from '@application/scene-canvas/vo/SceneCanvasArrangementVO'
import type { SceneCanvasWorkVersionGateway } from '@application/scene-canvas/ports/SceneCanvasWorkVersionGateway'
import type { SceneCandidatePreviewGateway } from '../../ports/SceneCandidatePreviewGateway'
import type { SceneGenerationProductionContext } from '../../ports/SceneGenerationProductionContext'

export interface SceneGenerationRenderDependencies {
  readonly canvasVersions: SceneCanvasWorkVersionGateway
  readonly saveArrangement: (request: SaveSceneCanvasArrangementDTO) => Promise<void>
  readonly readCurrentArrangement: (request: {
    projectId: string
    sceneId: string
    canvasId: string
  }) => Promise<SceneCanvasArrangementVO | null>
  readonly production: SceneGenerationProductionContext
  readonly preview: SceneCandidatePreviewGateway
}
