import type { VerifiedProjectReadLocation } from '../models/ProjectInputSourceReadFacts'
import type { SceneCanvasArrangementInspectionFact } from '../models/SceneCanvasArrangementReadFacts'

export interface SceneCanvasArrangementReaderGateway {
  inspectSceneCanvasArrangements(
    project: VerifiedProjectReadLocation
  ): Promise<SceneCanvasArrangementInspectionFact>
}
