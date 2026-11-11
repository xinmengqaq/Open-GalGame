import { ErrorCodes } from '@common/errors/ErrorCodes'

import {
  cardIconProps,
  cardKindLabel,
  cardTitleText,
  type SessionContentKind,
  type SessionTextKind
} from './contentKindLabel'
import type { SessionCard, SessionPromptCard } from './workbenchSession.types'

/**
 * 与领域 `SceneCanvasErrorCodes` 对齐的表现层判定码。
 * 只用于内部判别，不导入领域、不把数值码写进可见文案，也不按同名标题猜测引用对象。
 */
export const PROMPT_REFERENCE_DUPLICATE_CODE = 4401
export const PROMPT_REFERENCE_UNKNOWN_CODE = 4402

/** 与生成输入允许的引用类别一致；提示词本身和未知类别不进入候选。 */
const referenceableKinds: Record<Exclude<SessionCard['kind'], 'prompt'>, true> = {
  document: true,
  image: true,
  audio: true,
  video: true,
  animation: true,
  effect: true
}

export type PromptReferenceIdentity = {
  cardId: string
  displayName?: string
}

export type PromptReferenceTarget = {
  cardId: string
  kind: Exclude<SessionCard['kind'], 'prompt'>
  kindLabel: string
  displayName: string
  detail: string | null
  contentKind: SessionContentKind
  textKind?: SessionTextKind
}

export type PromptReferenceCandidate = PromptReferenceTarget & {
  searchText: string
}

export type PromptReferenceIssueKind =
  'missing' | 'self' | 'promptTarget' | 'unknown' | 'duplicate' | 'unreadable'

export type PromptReferenceIssue = {
  kind: PromptReferenceIssueKind
  message: string
}

export type PromptReferenceChipView = {
  cardId: string
  /** 只在目标仍是可引用卡片时出现；失效或非法目标不伪造卡片类别。 */
  kind: Exclude<SessionCard['kind'], 'prompt'> | null
  kindLabel: string | null
  displayName: string
  detail: string | null
  /** 目标不是可引用卡片时为 null，界面不显示类别图标。 */
  contentKind: SessionContentKind | null
  textKind?: SessionTextKind
  tone: 'valid' | 'warning' | 'invalid'
  issue: PromptReferenceIssue | null
}

export type PromptReferenceIssueSummary = {
  text: string
  tone: 'warning' | 'danger'
  removableIds: readonly string[]
}

export type PromptReferenceFailureView = {
  text: string
}

/** 提示词 `@` 输入触发的当前片段。start/end 直接用于替换正文。 */
export type PromptMention = {
  start: number
  end: number
  query: string
}

/**
 * 当前画布可引用的卡片：稳定身份来自 cardId，显示名只取当前卡片事实。
 * 提示词卡本身不进入候选，避免生成侧把提示词引用判为无效。
 */
export function promptReferenceTargetOf(card: SessionCard): PromptReferenceTarget | null {
  if (card.kind === 'prompt' || referenceableKinds[card.kind] !== true) return null
  const kindLabel = cardKindLabel(card.kind)
  const icon = cardIconProps(card)
  return {
    cardId: card.cardId,
    kind: card.kind,
    kindLabel,
    displayName: displayNameOf(card),
    detail: detailOf(card, kindLabel),
    contentKind: icon.contentKind,
    ...(icon.textKind === undefined ? {} : { textKind: icon.textKind })
  }
}

/**
 * 只检索当前会话的卡片。已引用、自身和提示词卡不在候选里。
 * 过滤使用当前显示名、类别和用途等真实字段，不读文件名或正文猜测用途。
 */
export function promptReferenceCandidates(
  cards: readonly SessionCard[],
  promptCardId: string,
  options: {
    query?: string
    referencedIds?: readonly string[]
    /** 候选构造阶段就要排除不可读来源；调用方必须给出真实判断。 */
    isSourceReadable: (sourceId: string) => boolean
  }
): PromptReferenceCandidate[] {
  const query = (options.query ?? '').trim().toLowerCase()
  const referenced = new Set(options.referencedIds ?? [])
  const seen = new Set<string>([promptCardId])
  const candidates: PromptReferenceCandidate[] = []
  for (const card of cards) {
    if (seen.has(card.cardId) || referenced.has(card.cardId)) continue
    seen.add(card.cardId)
    const target = promptReferenceTargetOf(card)
    if (!target) continue
    // 不可读的卡片不能进入候选；它只可能在已存在的失效引用里以警告状态出现。
    if ('sourceId' in card && !options.isSourceReadable(card.sourceId)) continue
    const searchText =
      `${target.displayName} ${target.kindLabel} ${target.detail ?? ''}`.toLowerCase()
    if (query.length > 0 && !searchText.includes(query)) continue
    candidates.push({ ...target, searchText })
  }
  return candidates
}

/**
 * 把持久化的 cardId 解析成当前展示。缺失、自己、另一张提示词、重复和来源不可读
 * 都保留在列表里并明确标出，不按标题寻找替代卡片。
 */
export function promptReferenceChipViews(
  cards: readonly SessionCard[],
  promptCard: Pick<SessionPromptCard, 'cardId'> & {
    references?: readonly PromptReferenceIdentity[]
  },
  isSourceReadable?: (sourceId: string) => boolean
): PromptReferenceChipView[] {
  const cardsById = new Map(cards.map((card) => [card.cardId, card]))
  const seen = new Set<string>()
  return (promptCard.references ?? []).map((reference) => {
    const label = reference.displayName?.trim()
    if (reference.cardId === promptCard.cardId) {
      return {
        cardId: reference.cardId,
        kind: null,
        kindLabel: null,
        displayName: label || '当前提示词',
        detail: '提示词不能引用自己',
        contentKind: null,
        tone: 'invalid',
        issue: {
          kind: 'self',
          message: '提示词不能引用自己。'
        }
      } satisfies PromptReferenceChipView
    }
    const card = cardsById.get(reference.cardId)
    if (!card) {
      return {
        cardId: reference.cardId,
        kind: null,
        kindLabel: null,
        displayName: label || '已失效的引用',
        detail: '已不在当前画布',
        contentKind: null,
        tone: 'invalid',
        issue: {
          kind: 'missing',
          message: '引用的卡片已不在当前画布，请移除后再保存。'
        }
      } satisfies PromptReferenceChipView
    }
    if (card.kind === 'prompt') {
      return {
        cardId: card.cardId,
        kind: null,
        kindLabel: '提示词',
        displayName: displayNameOf(card),
        detail: '不能引用另一张提示词',
        contentKind: 'text',
        textKind: 'prompt',
        tone: 'invalid',
        issue: {
          kind: 'promptTarget',
          message: '提示词不能引用另一张提示词卡。'
        }
      } satisfies PromptReferenceChipView
    }
    const target = promptReferenceTargetOf(card)
    if (!target) {
      return {
        cardId: card.cardId,
        kind: null,
        kindLabel: null,
        displayName: '无法识别的卡片',
        detail: '卡片类别不可用',
        contentKind: null,
        tone: 'invalid',
        issue: {
          kind: 'unknown',
          message: '引用的卡片类别无法识别，请移除后再保存。'
        }
      } satisfies PromptReferenceChipView
    }
    const duplicate = seen.has(card.cardId)
    if (!duplicate) seen.add(card.cardId)
    if (duplicate) {
      return {
        ...target,
        tone: 'invalid',
        issue: {
          kind: 'duplicate',
          message: '同一张卡片只能引用一次。'
        }
      } satisfies PromptReferenceChipView
    }
    if (isSourceReadable && 'sourceId' in card && !isSourceReadable(card.sourceId)) {
      return {
        ...target,
        tone: 'warning',
        issue: {
          kind: 'unreadable',
          message: `引用「${target.displayName}」的来源不可读取，请检查来源。`
        }
      } satisfies PromptReferenceChipView
    }
    return { ...target, tone: 'valid', issue: null } satisfies PromptReferenceChipView
  })
}

/** 卡片内提示只取第一条可处理的问题；阻塞保存的问题优先于来源警告。 */
export function promptReferenceIssueSummary(
  views: readonly PromptReferenceChipView[]
): PromptReferenceIssueSummary | null {
  const withIssues = views.filter((view) => view.issue !== null)
  if (withIssues.length === 0) return null
  const primary = withIssues.find((view) => view.issue?.kind !== 'unreadable') ?? withIssues[0]
  const issue = primary.issue
  if (!issue) return null
  const extra = withIssues.length - 1
  const text = extra > 0 ? `${issue.message}另有 ${extra} 项引用需要处理。` : issue.message
  return {
    text,
    tone: issue.kind === 'unreadable' ? 'warning' : 'danger',
    removableIds: [
      ...new Set(
        withIssues.filter((view) => view.issue?.kind !== 'unreadable').map((view) => view.cardId)
      )
    ]
  }
}

/**
 * 4401/4402/4101 只做内部判别，展示层统一换成可读中文。
 * 不把后端数值码或原始报文透传到可见文案里。
 */
export function promptReferenceFailureOf(
  failure: { code: number; message?: string } | null
): PromptReferenceFailureView | null {
  if (failure === null) return null
  const message = failure.message ?? ''
  // 4401/4402 也被画布其他校验复用；只有报文指向引用时才归到提示词问题。
  const referenceFailure = message.length === 0 || mentionsPromptReference(message)
  if (failure.code === PROMPT_REFERENCE_DUPLICATE_CODE && referenceFailure) {
    return { text: '同一提示词不能重复引用同一卡片。' }
  }
  if (failure.code === PROMPT_REFERENCE_UNKNOWN_CODE && referenceFailure) {
    return { text: '提示词引用必须是当前画布中的其他卡片。' }
  }
  if (failure.code !== ErrorCodes.invalidRequest || !mentionsPromptReference(message)) return null
  return {
    text: message.includes('重复')
      ? '同一提示词不能重复引用同一卡片。'
      : '提示词引用的卡片不在当前画布或无法读取。'
  }
}

/** 生成侧 4101 是通用请求错误，只有文案指向引用时才显示到提示词卡上。 */
export function mentionsPromptReference(message: string): boolean {
  return message.includes('引用')
}

/**
 * 从光标向前找 `@查询`。触发符必须在行首、空白或常见标点之后，
 * 避免把邮箱等普通文本当成引用入口。
 */
export function promptMentionAt(value: string, caret: number): PromptMention | null {
  const end = Math.max(0, Math.min(caret, value.length))
  const before = value.slice(0, end)
  const match =
    /(^|[\s，。、；：！？,.!?;:（(【[])@([^\s@，。、；：！？,.!?;:（）()【\]]{0,40})$/.exec(before)
  if (match === null) return null
  return {
    start: before.length - match[0].length + match[1].length,
    end,
    query: match[2]
  }
}

/** 选中候选后移除触发文本，保留原有正文并在需要时补一个空格。 */
export function removePromptMentionText(
  value: string,
  mention: Pick<PromptMention, 'start' | 'end'>
): { value: string; caret: number } {
  const before = value.slice(0, mention.start)
  const after = value.slice(mention.end)
  // 触发符两侧都有空白时去掉一处，避免删除 `@` 后留下双空格。
  const trimmedAfter = /\s$/.test(before) && /^\s/.test(after) ? after.slice(1) : after
  const needsSpace =
    before.length > 0 && !/\s$/.test(before) && trimmedAfter.length > 0 && !/^\s/.test(trimmedAfter)
  return {
    value: `${before}${needsSpace ? ' ' : ''}${trimmedAfter}`,
    caret: before.length + (needsSpace ? 1 : 0)
  }
}

export function promptReferenceIds(
  references: readonly PromptReferenceIdentity[] | undefined
): string[] {
  return (references ?? []).map((reference) => reference.cardId)
}

export function appendPromptReferenceId(
  references: readonly PromptReferenceIdentity[] | undefined,
  cardId: string
): string[] {
  const ids = promptReferenceIds(references)
  return ids.includes(cardId) ? ids : [...ids, cardId]
}

export function removePromptReferenceIds(
  references: readonly PromptReferenceIdentity[] | undefined,
  cardIds: readonly string[]
): string[] {
  const removed = new Set(cardIds)
  return promptReferenceIds(references).filter((cardId) => !removed.has(cardId))
}

function displayNameOf(card: SessionCard): string {
  const title = cardTitleText(card).trim()
  return title.length > 0 ? title : cardKindLabel(card.kind)
}

function detailOf(
  card: Exclude<SessionCard, { kind: 'prompt' }>,
  kindLabel: string
): string | null {
  if (card.kind === 'image' || card.kind === 'audio' || card.kind === 'video') {
    const summary = card.summary.trim()
    return summary.length > 0 ? summary : '未写用途'
  }
  if ((card.kind === 'animation' || card.kind === 'effect') && card.webgalPreset !== null) {
    return `${kindLabel} · ${card.webgalPreset.command}`
  }
  return kindLabel
}
