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

export function cardIconProps(card: SessionCard): {
  contentKind: SessionContentKind
  textKind?: SessionTextKind
} {
  if (card.kind === 'prompt') return { contentKind: 'text', textKind: 'prompt' }
  if (card.kind === 'document') return { contentKind: 'text', textKind: 'document' }
  return { contentKind: card.kind }
}

export function cardTitleText(card: SessionCard): string {
  if (card.kind === 'prompt') return '提示词'
  if (card.kind === 'animation' || card.kind === 'effect') {
    return card.webgalPreset
      ? presetLabelOf(card.kind, card.webgalPreset.name)
      : cardKindLabels[card.kind]
  }
  return card.title
}

export function isPreviewCard(kind: SessionCardKind): boolean {
  return kind === 'image' || kind === 'video'
}

export function isSourceCard(card: SessionCard): card is SessionSourceCard {
  return card.kind !== 'prompt' && card.kind !== 'animation' && card.kind !== 'effect'
}

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
