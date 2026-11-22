export type SceneCanvasCardLayout = {
  x: number
  y: number
  width: number
  height: number
}

export type SceneCanvasViewport = {
  x: number
  y: number
  zoom: number
}

export type SceneCanvasUsage = {
  characterId?: string
  locationId?: string
  spokenLine?: string
  targetIds: readonly string[]
}

export type SceneCanvasDefaultRelation =
  | 'actsOn'
  | 'accompanies'
  | 'voices'
  | 'depicts'
  | 'constrains'
  | 'sameSubject'
  | 'associated'

export type SceneCanvasWebgalPreset = {
  command: string
  name: string
}
export type SceneCanvasImageRole = 'background' | 'cg' | 'characterImage' | 'avatar'

export type SceneCanvasAudioRole = 'music' | 'soundEffect' | 'voice'

export type SceneCanvasDocumentCard = {
  kind: 'document'
  cardId: string
  sourceId: string
  title: string
  summary: string
  usage: SceneCanvasUsage
  layout: SceneCanvasCardLayout
}

export type SceneCanvasImageCard = {
  kind: 'image'
  cardId: string
  sourceId: string
  role: SceneCanvasImageRole
  title: string
  summary: string
  usage: SceneCanvasUsage
  layout: SceneCanvasCardLayout
}

export type SceneCanvasAudioCard = {
  kind: 'audio'
  cardId: string
  sourceId: string
  role: SceneCanvasAudioRole
  title: string
  summary: string
  usage: SceneCanvasUsage
  layout: SceneCanvasCardLayout
}

export type SceneCanvasVideoCard = {
  kind: 'video'
  cardId: string
  sourceId: string
  title: string
  summary: string
  usage: SceneCanvasUsage
  layout: SceneCanvasCardLayout
}

export type SceneCanvasPromptReference = {
  cardId: string
}

export type SceneCanvasPromptCard = {
  kind: 'prompt'
  cardId: string
  title: string
  summary: string
  body: string
  references: readonly SceneCanvasPromptReference[]
  usage: SceneCanvasUsage
  layout: SceneCanvasCardLayout
}

export type SceneCanvasAnimationCard = {
  kind: 'animation'
  cardId: string
  title: string
  summary: string
  webgalPreset: SceneCanvasWebgalPreset | null
  usage: SceneCanvasUsage
  layout: SceneCanvasCardLayout
}

export type SceneCanvasEffectCard = {
  kind: 'effect'
  cardId: string
  title: string
  summary: string
  webgalPreset: SceneCanvasWebgalPreset | null
  usage: SceneCanvasUsage
  layout: SceneCanvasCardLayout
}

export type SceneCanvasFieldCard = SceneCanvasAnimationCard | SceneCanvasEffectCard

export type SceneCanvasSourceCard =
  SceneCanvasDocumentCard | SceneCanvasImageCard | SceneCanvasAudioCard | SceneCanvasVideoCard

export type SceneCanvasCard = SceneCanvasSourceCard | SceneCanvasPromptCard | SceneCanvasFieldCard

export type SceneCanvasRelation = {
  relationId: string
  fromCardId: string
  toCardId: string
  defaultRelation: SceneCanvasDefaultRelation
  specificName: string
  recordCardId: string | null
}

export type SceneCanvasArrangement = {
  projectId: string
  sceneId: string
  canvasId: string
  viewport: SceneCanvasViewport
  cards: readonly SceneCanvasCard[]
  relations: readonly SceneCanvasRelation[]
}

export function sceneCanvasCardSourceId(card: SceneCanvasCard): string | null {
  if (
    card.kind === 'document' ||
    card.kind === 'image' ||
    card.kind === 'audio' ||
    card.kind === 'video'
  ) {
    return card.sourceId
  }
  return null
}
