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

/** 卡片绑定的 WebGAL 命令与名称。未选择时为 null。不解释命令含义。 */
export type SceneCanvasWebgalPreset = {
  command: string
  name: string
}
/** 图片卡的场景用途。来源只说明它是图片，不区分背景、CG、立绘或头像。 */
export type SceneCanvasImageRole = 'background' | 'cg' | 'characterImage' | 'avatar'

/** 音频卡的场景用途。来源只说明它是音频，不区分音乐、音效或配音。 */
export type SceneCanvasAudioRole = 'music' | 'soundEffect' | 'voice'

export type SceneCanvasDocumentCard = {
  kind: 'document'
  cardId: string
  sourceId: string
  title: string
  summary: string
  layout: SceneCanvasCardLayout
}

export type SceneCanvasImageCard = {
  kind: 'image'
  cardId: string
  sourceId: string
  role: SceneCanvasImageRole
  title: string
  summary: string
  layout: SceneCanvasCardLayout
}

export type SceneCanvasAudioCard = {
  kind: 'audio'
  cardId: string
  sourceId: string
  role: SceneCanvasAudioRole
  title: string
  summary: string
  layout: SceneCanvasCardLayout
}

export type SceneCanvasVideoCard = {
  kind: 'video'
  cardId: string
  sourceId: string
  title: string
  summary: string
  layout: SceneCanvasCardLayout
}

/** 提示词绑定的当前画布卡片。身份只保存 cardId，显示名不进入身份。 */
export type SceneCanvasPromptReference = {
  cardId: string
}

export type SceneCanvasPromptCard = {
  kind: 'prompt'
  cardId: string
  body: string
  references: readonly SceneCanvasPromptReference[]
  layout: SceneCanvasCardLayout
}

export type SceneCanvasAnimationCard = {
  kind: 'animation'
  cardId: string
  webgalPreset: SceneCanvasWebgalPreset | null
  layout: SceneCanvasCardLayout
}

export type SceneCanvasEffectCard = {
  kind: 'effect'
  cardId: string
  webgalPreset: SceneCanvasWebgalPreset | null
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
  specificName: string
  recordCardId: string | null
}

/** 一份场景编排。不含编排版本、路径、正文、选中状态和撤销栈。 */
export type SceneCanvasArrangement = {
  projectId: string
  sceneId: string
  canvasId: string
  viewport: SceneCanvasViewport
  cards: readonly SceneCanvasCard[]
  relations: readonly SceneCanvasRelation[]
}

/**
 * 卡片挂接的工程来源。提示词和字段卡片没有来源文件。
 * @returns 来源身份；没有来源时为 null。
 */
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
