import type { SceneCanvasArrangementInspectionItem } from '@domain/project-files/models/ProjectFileDiagnostic'

/** 工程内已识别编排的检查事实。没有已保存编排时集合为空，不因此制造缺失诊断。 */
export type SceneCanvasArrangementInspectionFact = {
  projectId: string
  canvasArrangementFormatSupported: boolean
  arrangements: readonly SceneCanvasArrangementInspectionItem[]
}

export type { SceneCanvasArrangementInspectionItem }
