export type SceneCanvasCardLayoutVO = {
  x: number
  y: number
  width: number
  height: number
}

export type SceneCanvasViewportVO = {
  x: number
  y: number
  zoom: number
}

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

export type SceneCanvasRelationVO = {
  relationId: string
  fromCardId: string
  toCardId: string
  specificName: string
  recordCardId: string | null
}

export type SceneCanvasArrangementVO = {
  projectId: string
  sceneId: string
  canvasId: string
  viewport: SceneCanvasViewportVO
  cards: readonly SceneCanvasCardVO[]
  relations: readonly SceneCanvasRelationVO[]
}
