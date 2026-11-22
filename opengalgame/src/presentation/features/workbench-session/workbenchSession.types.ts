import type { ProjectFileDiagnosticVO } from '@application/project-files/vo/ProjectFilesInspectionVO'
import type {
  ProjectInputSourceSummaryVO,
  ProjectInputSourceVO
} from '@application/project-files/vo/ProjectInputSourceVO'
import type {
  SceneCanvasAnimationCardVO,
  SceneCanvasAudioCardVO,
  SceneCanvasCardLayoutVO,
  SceneCanvasCardVO,
  SceneCanvasDocumentCardVO,
  SceneCanvasEffectCardVO,
  SceneCanvasImageCardVO,
  SceneCanvasPromptCardVO,
  SceneCanvasRelationVO,
  SceneCanvasSourceCardVO,
  SceneCanvasVideoCardVO,
  SceneCanvasViewportVO
} from '@application/scene-canvas/vo/SceneCanvasArrangementVO'
import type { FailureState } from '../../feedback/failure'

export const FIRST_SCENE_LABEL = '当前场景'

export const SOURCE_DRAG_MIME = 'application/x-opengalgame-source'
export const HISTORY_LIMIT = 40

export type SessionCard = SceneCanvasCardVO
export type SessionRelation = SceneCanvasRelationVO
export type SessionCardLayout = SceneCanvasCardLayoutVO
export type SessionViewport = SceneCanvasViewportVO
export type SessionSourceCard = SceneCanvasSourceCardVO
export type SessionDocumentCard = SceneCanvasDocumentCardVO
export type SessionImageCard = SceneCanvasImageCardVO
export type SessionAudioCard = SceneCanvasAudioCardVO
export type SessionVideoCard = SceneCanvasVideoCardVO
export type SessionPromptCard = SceneCanvasPromptCardVO
export type SessionFieldCard = SceneCanvasAnimationCardVO | SceneCanvasEffectCardVO
export type SessionCardKind = SessionCard['kind']

export type InputSourceDragPayload = {
  projectId: string
  sourceId: string
}

export type WorkspaceLoadStatus = 'idle' | 'loading' | 'ready' | 'empty' | 'failed'

export type WorkbenchSaveState =
  | 'idle'
  | 'dirty'
  | 'saving'
  | 'saved'
  | 'unsaved'
  | 'committedUnsubmitted'
  | 'unverified'
  | 'failed'

export type SessionSnapshot = {
  cards: SessionCard[]
  relations: SessionRelation[]
  viewport: SessionViewport
}

export type WorkbenchSessionIdentity = {
  projectId: string
  projectName: string
  sceneId: string
  canvasId: string
  sceneLabel: string
}

export type PromptReferenceAlert = {
  message: string
  cardId?: string
}

export type WorkbenchSessionState = WorkbenchSessionIdentity & {
  catalogStatus: WorkspaceLoadStatus
  catalogError: FailureState | null
  sources: readonly ProjectInputSourceSummaryVO[]
  sourceDetails: Readonly<Record<string, ProjectInputSourceVO>>
  arrangementStatus: WorkspaceLoadStatus
  arrangementError: FailureState | null
  inspectionDiagnostics: readonly ProjectFileDiagnosticVO[]
  cards: SessionCard[]
  relations: SessionRelation[]
  selectedCardId: string | null
  viewport: SessionViewport
  documentLayerCardId: string | null
  baseline: SessionSnapshot | null
  past: SessionSnapshot[]
  future: SessionSnapshot[]
  saveState: WorkbenchSaveState
  saveError: FailureState | null
  promptReferenceAlert: PromptReferenceAlert | null
  pageBlocked: boolean
  revision: number
  structuralRevision: number
  cardEditRevisions: Readonly<Record<string, number>>
  layoutRevisions: Readonly<Record<string, number>>
  viewportRevision: number
}
