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

/** 首版场景名称。场景和画布身份由工程工作区返回，不在前端写死。 */
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
export type SessionAnimationCard = SceneCanvasAnimationCardVO
export type SessionEffectCard = SceneCanvasEffectCardVO
export type SessionFieldCard = SceneCanvasAnimationCardVO | SceneCanvasEffectCardVO
export type SessionCardKind = SessionCard['kind']

export type InputSourceDragPayload = {
  projectId: string
  sourceId: string
}

export type WorkspaceLoadStatus = 'idle' | 'loading' | 'ready' | 'empty' | 'failed'

/**
 * 保存结果。idle 表示还没有可保存内容；saved 只在保存用例确认保持后出现。
 * unverified 对应提交结果不明，界面显示“结果待核对”。
 */
export type WorkbenchSaveState =
  | 'idle'
  | 'dirty'
  | 'saving'
  | 'saved'
  | 'unsaved'
  | 'committedUnsubmitted'
  | 'unverified'
  | 'failed'

/** 撤销栈中的一次完整画布快照。不持久化。 */
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

/**
 * 提示词引用校验失败。保存失败没有单张卡片归属；编辑或生成失败有来源时带上 cardId，
 * 由提示词卡在正文旁显示，不依赖转瞬即逝的 Toast。
 */
export type PromptReferenceAlert = {
  /** 已映射的可读原因；不含后端数值码。 */
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
  /** 上一次确认保持的快照。没有保存文件时为 null。 */
  baseline: SessionSnapshot | null
  past: SessionSnapshot[]
  future: SessionSnapshot[]
  saveState: WorkbenchSaveState
  saveError: FailureState | null
  /** 最近一次引用校验失败的提示。成功保存、修改引用或切换会话后清除。 */
  promptReferenceAlert: PromptReferenceAlert | null
  pageBlocked: boolean
  /** 本会话内容修订号，用于拒绝旧响应覆盖新草稿。 */
  revision: number
  /** 结构修订号（卡片或关联增删）。旧响应在结构变化后整份丢弃。 */
  structuralRevision: number
  /** 每张卡片最近一次内容编辑的修订号。 */
  cardEditRevisions: Readonly<Record<string, number>>
  /** 每张卡片最近一次布局编辑的修订号。 */
  layoutRevisions: Readonly<Record<string, number>>
  /** 最近一次视口修改的修订号。 */
  viewportRevision: number
}
