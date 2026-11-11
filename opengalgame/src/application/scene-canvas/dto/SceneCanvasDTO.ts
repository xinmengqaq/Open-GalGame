import type {
  SceneCanvasArrangementVO,
  SceneCanvasAudioRoleVO,
  SceneCanvasCardLayoutVO,
  SceneCanvasImageRoleVO,
  SceneCanvasWebgalPresetVO
} from '../vo/SceneCanvasArrangementVO'

/** 一次编辑请求的公共身份与当前草稿。 */
export type SceneCanvasEditRequest = {
  projectId: string
  sceneId: string
  canvasId: string
  /** 画布会话内存中的当前编排。编辑规则以它为准，不读已落盘编排。 */
  arrangement: SceneCanvasArrangementVO
}

/** 保存原因。周期保存、保存按钮和生成前强制保存走同一用例。 */
export type SceneCanvasSaveReason = 'periodic' | 'manual' | 'beforeGeneration'

export type ReadSceneCanvasArrangementDTO = {
  projectId: string
  sceneId: string
  canvasId: string
}

export type SaveSceneCanvasArrangementDTO = {
  projectId: string
  sceneId: string
  canvasId: string
  reason: SceneCanvasSaveReason
  /** 要落盘的整份编排，含布局与视口，不含选中状态和撤销栈。 */
  arrangement: SceneCanvasArrangementVO
}

export type CreateSceneCanvasSourceCardDTO = SceneCanvasEditRequest & {
  sourceId: string
  layout: SceneCanvasCardLayoutVO
}

export type CreateSceneCanvasPromptCardDTO = SceneCanvasEditRequest & {
  layout: SceneCanvasCardLayoutVO
}

export type CreateSceneCanvasFieldCardDTO = SceneCanvasEditRequest & {
  kind: 'animation' | 'effect'
  layout: SceneCanvasCardLayoutVO
}

export type EditSceneCanvasCardDTO = SceneCanvasEditRequest & {
  cardId: string
  title?: string
  summary?: string
}

export type EditSceneCanvasPromptBodyDTO = SceneCanvasEditRequest & {
  cardId: string
  body: string
}

export type BindSceneCanvasFieldCardPresetDTO = SceneCanvasEditRequest & {
  cardId: string
  preset: SceneCanvasWebgalPresetVO | null
}

export type EditSceneCanvasMediaRoleDTO = SceneCanvasEditRequest & {
  cardId: string
  role: SceneCanvasImageRoleVO | SceneCanvasAudioRoleVO
}

export type CopySceneCanvasCardDTO = SceneCanvasEditRequest & {
  cardId: string
  layout: SceneCanvasCardLayoutVO
}

export type DeleteSceneCanvasCardDTO = SceneCanvasEditRequest & {
  cardId: string
}

export type ConnectSceneCanvasCardsDTO = SceneCanvasEditRequest & {
  fromCardId: string
  toCardId: string
}

export type DisconnectSceneCanvasCardsDTO = SceneCanvasEditRequest & {
  relationId: string
}

export type EditSceneCanvasRelationNameDTO = SceneCanvasEditRequest & {
  relationId: string
  specificName: string
}

export type AttachSceneCanvasRelationRecordDTO = SceneCanvasEditRequest & {
  relationId: string
  recordCardId: string
}

export type DetachSceneCanvasRelationRecordDTO = SceneCanvasEditRequest & {
  relationId: string
}
