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

/** 卡片绑定的 WebGAL 命令与名称。未选择时为 null。不解释命令含义。 */
export type ProjectCanvasWebgalPreset = {
  command: string
  name: string
}

export type ProjectCanvasImageRole = 'background' | 'cg' | 'characterImage' | 'avatar'

export type ProjectCanvasAudioRole = 'music' | 'soundEffect' | 'voice'

/** 已保存的默认关系。不在读取时按卡片类型重新推断。 */
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

/** 旧生成适配保留的提示词引用。身份只含 cardId。 */
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

/** 卡片是否挂接着工程来源。提示词和字段卡片没有来源文件。 */
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
