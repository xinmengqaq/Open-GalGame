export type ProjectCanvasUsageSettings = {
  characterId?: string
  locationId?: string
  spokenLine?: string
  targetIds: readonly string[]
}

export type ProjectCanvasCardLayout = {
  x: number
  y: number
  width: number
  height: number
}

export type ProjectCanvasViewport = {
  x: number
  y: number
  zoom: number
}

export type ProjectCanvasWebgalPreset = {
  command: string
  name: string
}

export type ProjectCanvasImageRole = 'background' | 'cg' | 'characterImage' | 'avatar'

export type ProjectCanvasAudioRole = 'music' | 'soundEffect' | 'voice'

export type ProjectCanvasDefaultRelation =
  'actsOn' | 'accompanies' | 'voices' | 'depicts' | 'constrains' | 'sameSubject' | 'associated'

type ProjectCanvasCardBase = {
  cardId: string
  title: string
  summary: string
  usage: ProjectCanvasUsageSettings
  layout: ProjectCanvasCardLayout
}

export type ProjectCanvasDocumentCard = ProjectCanvasCardBase & {
  kind: 'document'
  sourceId: string
}

export type ProjectCanvasPromptReference = {
  cardId: string
}

export type ProjectCanvasPromptCard = ProjectCanvasCardBase & {
  kind: 'prompt'
  body: string
  references: readonly ProjectCanvasPromptReference[]
}

export type ProjectCanvasImageCard = ProjectCanvasCardBase & {
  kind: 'image'
  sourceId: string
  role: ProjectCanvasImageRole
}

export type ProjectCanvasAudioCard = ProjectCanvasCardBase & {
  kind: 'audio'
  sourceId: string
  role: ProjectCanvasAudioRole
}

export type ProjectCanvasVideoCard = ProjectCanvasCardBase & {
  kind: 'video'
  sourceId: string
}

export type ProjectCanvasAnimationCard = ProjectCanvasCardBase & {
  kind: 'animation'
  webgalPreset: ProjectCanvasWebgalPreset | null
}

export type ProjectCanvasEffectCard = ProjectCanvasCardBase & {
  kind: 'effect'
  webgalPreset: ProjectCanvasWebgalPreset | null
}

export type ProjectCanvasFieldCard = ProjectCanvasAnimationCard | ProjectCanvasEffectCard

export type ProjectCanvasSourceCard =
  | ProjectCanvasDocumentCard
  | ProjectCanvasImageCard
  | ProjectCanvasAudioCard
  | ProjectCanvasVideoCard

export type ProjectCanvasCard =
  ProjectCanvasSourceCard | ProjectCanvasPromptCard | ProjectCanvasFieldCard

export type ProjectCanvasRelation = {
  relationId: string
  fromCardId: string
  toCardId: string
  defaultRelation: ProjectCanvasDefaultRelation
  specificName: string
  recordCardId: string | null
}

export type ProjectCanvasArrangement = {
  projectId: string
  sceneId: string
  canvasId: string
  version: string
  viewport: ProjectCanvasViewport
  cards: readonly ProjectCanvasCard[]
  relations: readonly ProjectCanvasRelation[]
}

export function canvasCardSourceId(card: ProjectCanvasCard): string | null {
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
