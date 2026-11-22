import type { SceneCanvasArrangementInspectionItem } from '@domain/project-files/models/ProjectFileDiagnostic'

export type SceneCanvasArrangementInspectionFact = {
  projectId: string
  canvasArrangementFormatSupported: boolean
  arrangements: readonly SceneCanvasArrangementInspectionItem[]
}

export type { SceneCanvasArrangementInspectionItem }
