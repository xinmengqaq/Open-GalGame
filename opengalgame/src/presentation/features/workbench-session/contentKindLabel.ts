import type {
  ProjectFileAssetKind,
  ProjectInputContentKind,
  ProjectInputSourceSummaryVO,
  ProjectInputSourceVO
} from '@application/project-files/vo/ProjectInputSourceVO'
import { presetLabelOf, type SessionFieldKind } from './webgalPreset'
import type {
  SessionCard,
  SessionCardKind,
  SessionDocumentCard,
  SessionSourceCard
} from './workbenchSession.types'

export type SessionTextKind = 'document' | 'prompt'
export type SessionContentKind = ProjectInputContentKind | SessionFieldKind

const textLabels: Record<SessionTextKind, string> = {
  document: '文档',
  prompt: '提示词'
}

const assetLabels: Record<ProjectFileAssetKind, string> = {
  image: '图片',
  audio: '音频',
  video: '视频'
}

const fieldLabels: Record<SessionFieldKind, string> = {
  animation: '动画',
  effect: '特效'
}

const cardKindLabels: Record<SessionCardKind, string> = {
  document: '文档',
  prompt: '提示词',
  image: '图片',
  audio: '音频',
  video: '视频',
  animation: '动画',
  effect: '特效'
}

export function contentKindLabel(
  contentKind: SessionContentKind,
  textKind?: SessionTextKind
): string {
  if (contentKind === 'text') return textKind ? textLabels[textKind] : '文本'
  if (contentKind === 'animation' || contentKind === 'effect') return fieldLabels[contentKind]
  return assetLabels[contentKind]
}

export function cardKindLabel(kind: SessionCardKind): string {
  return cardKindLabels[kind]
}

/** 卡片图标沿用来源类别的图标集合。 */
export function cardIconProps(card: SessionCard): {
  contentKind: SessionContentKind
  textKind?: SessionTextKind
} {
  if (card.kind === 'prompt') return { contentKind: 'text', textKind: 'prompt' }
  if (card.kind === 'document') return { contentKind: 'text', textKind: 'document' }
  return { contentKind: card.kind }
}

/** 标题展示值。提示词没有标题，字段卡取预设名或类型名。 */
export function cardTitleText(card: SessionCard): string {
  if (card.kind === 'prompt') return '提示词'
  if (card.kind === 'animation' || card.kind === 'effect') {
    return card.webgalPreset
      ? presetLabelOf(card.kind, card.webgalPreset.name)
      : cardKindLabels[card.kind]
  }
  return card.title
}

/** 图片、视频预览卡片可由用户按比例缩放。 */
export function isPreviewCard(kind: SessionCardKind): boolean {
  return kind === 'image' || kind === 'video'
}

export function isSourceCard(card: SessionCard): card is SessionSourceCard {
  return card.kind !== 'prompt' && card.kind !== 'animation' && card.kind !== 'effect'
}

export function isDocumentCard(card: SessionCard): card is SessionDocumentCard {
  return card.kind === 'document'
}

/** 通用编辑弹窗只接受拥有标题（和简介）的卡片。 */
export function isEditableCard(card: SessionCard): boolean {
  return (
    card.kind === 'document' ||
    card.kind === 'image' ||
    card.kind === 'audio' ||
    card.kind === 'video'
  )
}

/** 文档、图片、音频和视频卡都有摘要字段；文档称简介，媒体称用途说明。 */
export function supportsSummary(card: SessionCard): boolean {
  return (
    card.kind === 'document' ||
    card.kind === 'image' ||
    card.kind === 'audio' ||
    card.kind === 'video'
  )
}

export function catalogGroupOf(contentKind: ProjectInputContentKind): 'text' | 'asset' {
  if (contentKind === 'text') return 'text'
  return 'asset'
}

/** 来源类别落到卡片类别。文本来源一律建文档卡。 */
export function sourceCardKindOf(
  summary: Pick<ProjectInputSourceSummaryVO, 'contentKind'> | ProjectInputSourceVO
): SessionCardKind {
  return summary.contentKind === 'text' ? 'document' : summary.contentKind
}

const sizes: Record<SessionCardKind, { width: number; height: number }> = {
  document: { width: 300, height: 224 },
  prompt: { width: 320, height: 252 },
  image: { width: 320, height: 208 },
  audio: { width: 300, height: 176 },
  video: { width: 320, height: 200 },
  animation: { width: 296, height: 208 },
  effect: { width: 296, height: 208 }
}

export function defaultCardSize(kind: SessionCardKind): { width: number; height: number } {
  return sizes[kind]
}
