import type { SceneCanvasArrangement } from '@domain/scene-canvas/models/SceneCanvasArrangement'
import type { ProjectInputSource } from './ProjectInputSource'

export type ProjectFileDiagnosticKind =
  'missing' | 'damaged' | 'duplicateIdentity' | 'brokenReference'

export type ProjectFileDiagnostic = {
  objectId: string
  kind: ProjectFileDiagnosticKind
}

export type ProjectInputSourceFact =
  | { availability: 'present'; source: ProjectInputSource }
  | { availability: 'missing'; sourceId: string }
  | { availability: 'damaged'; sourceId: string }

export type SceneCanvasArrangementInspectionItem =
  | { availability: 'present'; arrangement: SceneCanvasArrangement }
  | { availability: 'missing' | 'damaged'; objectId: string }

export type ProjectFileInspectionFacts = {
  projectId: string
  inputSourceFormatSupported: boolean
  canvasArrangementFormatSupported: boolean
  sources: readonly ProjectInputSourceFact[]
  arrangements: readonly SceneCanvasArrangementInspectionItem[]
  catalogDamaged?: boolean
}

export type ProjectFileInspection = {
  projectId: string
  inputSourceFormatSupported: boolean
  canvasArrangementFormatSupported: boolean
  diagnostics: readonly ProjectFileDiagnostic[]
}
