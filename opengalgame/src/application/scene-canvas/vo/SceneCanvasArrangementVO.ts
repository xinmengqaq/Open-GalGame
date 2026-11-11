/** 卡片在画布上的位置和尺寸。不包含选中状态。 */
export type SceneCanvasCardLayoutVO = {
  x: number
  y: number
  width: number
  height: number
}

/** 画布视口。只用于恢复画布，不进入生成输入。 */
export type SceneCanvasViewportVO = {
  x: number
  y: number
  zoom: number
}

/** 卡片绑定的 WebGAL 命令与名称。未选择时为 null。不解释命令含义。 */
export type SceneCanvasWebgalPresetVO = {
  command: string
  name: string
}
export type SceneCanvasImageRoleVO = 'background' | 'cg' | 'characterImage' | 'avatar'

export type SceneCanvasAudioRoleVO = 'music' | 'soundEffect' | 'voice'

export type SceneCanvasDocumentCardVO = {
  kind: 'document'
  cardId: string
  sourceId: string
  title: string
  summary: string
  layout: SceneCanvasCardLayoutVO
}

export type SceneCanvasImageCardVO = {
  kind: 'image'
  cardId: string
  sourceId: string
  role: SceneCanvasImageRoleVO
  title: string
  summary: string
  layout: SceneCanvasCardLayoutVO
}

export type SceneCanvasAudioCardVO = {
  kind: 'audio'
  cardId: string
  sourceId: string
  role: SceneCanvasAudioRoleVO
  title: string
  summary: string
  layout: SceneCanvasCardLayoutVO
}

export type SceneCanvasVideoCardVO = {
  kind: 'video'
  cardId: string
  sourceId: string
  title: string
  summary: string
  layout: SceneCanvasCardLayoutVO
}

/** 提示词绑定的当前画布卡片。只保存稳定身份，显示名由读取事实解析。 */
export type SceneCanvasPromptReferenceVO = {
  cardId: string
  displayName?: string
}

export type SceneCanvasPromptCardVO = {
  kind: 'prompt'
  cardId: string
  body: string
  references: readonly SceneCanvasPromptReferenceVO[]
  layout: SceneCanvasCardLayoutVO
}

export type SceneCanvasAnimationCardVO = {
  kind: 'animation'
  cardId: string
  webgalPreset: SceneCanvasWebgalPresetVO | null
  layout: SceneCanvasCardLayoutVO
}

export type SceneCanvasEffectCardVO = {
  kind: 'effect'
  cardId: string
  webgalPreset: SceneCanvasWebgalPresetVO | null
  layout: SceneCanvasCardLayoutVO
}

export type SceneCanvasFieldCardVO = SceneCanvasAnimationCardVO | SceneCanvasEffectCardVO

export type SceneCanvasSourceCardVO =
  | SceneCanvasDocumentCardVO
  | SceneCanvasImageCardVO
  | SceneCanvasAudioCardVO
  | SceneCanvasVideoCardVO

export type SceneCanvasCardVO =
  SceneCanvasSourceCardVO | SceneCanvasPromptCardVO | SceneCanvasFieldCardVO

/** 用户拉出的连线。没有名称和记录时仍可保存，系统不补关系。 */
export type SceneCanvasRelationVO = {
  relationId: string
  fromCardId: string
  toCardId: string
  specificName: string
  recordCardId: string | null
}

/** 一份可保存的场景编排。不含选中状态、撤销栈、来源正文和作品修订身份。 */
export type SceneCanvasArrangementVO = {
  projectId: string
  sceneId: string
  canvasId: string
  viewport: SceneCanvasViewportVO
  cards: readonly SceneCanvasCardVO[]
  relations: readonly SceneCanvasRelationVO[]
}
