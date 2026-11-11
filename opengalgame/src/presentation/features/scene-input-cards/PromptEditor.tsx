import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactElement
} from 'react'
import { createPortal } from 'react-dom'
import { useShallow } from 'zustand/react/shallow'

import { ContentKindIcon } from '../workbench-session/ContentKindIcon'
import {
  promptMentionAt,
  promptReferenceCandidates,
  promptReferenceChipViews,
  promptReferenceFailureOf,
  promptReferenceIssueSummary,
  removePromptMentionText,
  type PromptMention,
  type PromptReferenceCandidate
} from '../workbench-session/promptReferences'
import { useWorkbenchCommands } from '../workbench-session/workbenchCommandsContext'
import { useWorkbenchSessionStore } from '../workbench-session/workbenchSession.store'
import { sourceFactsOf } from '../workbench-session/workbenchSessionSelectors'
import { CardAlertIcon, CardClearIcon } from './InputCardIcons'
import styles from './SceneInputCards.module.css'
import { usePromptFocusMotion } from './useInputCardMotion'

interface PromptEditorProps {
  cardId: string
  value: string
  editing: boolean
  onExitEditing: () => void
}

type DisplayedAlert = {
  text: string
  tone: 'warning' | 'danger'
  removableIds: readonly string[]
}

type PickerPosition = {
  top: number
  left: number
  width: number
}

/**
 * 提示词正文直接编辑。`@` 只检索当前画布卡片，选中后把稳定 cardId 存进引用集合，
 * 正文只保留用户的自然语言；引用展示按当前卡片的显示名解析，重命名会自动更新。
 */
export function PromptEditor({
  cardId,
  value,
  editing,
  onExitEditing
}: PromptEditorProps): ReactElement {
  const commands = useWorkbenchCommands()
  const session = useWorkbenchSessionStore(
    useShallow((state) => ({
      cards: state.cards,
      sources: state.sources,
      sourceDetails: state.sourceDetails,
      catalogStatus: state.catalogStatus,
      saveError: state.saveError,
      promptReferenceAlert: state.promptReferenceAlert
    }))
  )
  const root = useRef<HTMLDivElement>(null)
  const area = useRef<HTMLTextAreaElement>(null)
  const display = useRef<HTMLDivElement>(null)
  const picker = useRef<HTMLDivElement>(null)
  const pendingCaret = useRef<number | null>(null)
  const pendingScroll = useRef<number | null>(null)
  const [focused, setFocused] = useState(false)
  const [displayFade, setDisplayFade] = useState(false)
  const [mention, setMention] = useState<PromptMention | null>(null)
  const [activeIndex, setActiveIndex] = useState(0)
  const [pickerPosition, setPickerPosition] = useState<PickerPosition | null>(null)
  const rawListId = useId()
  const listId = `prompt-reference-${rawListId.replace(/:/g, '')}`
  usePromptFocusMotion(root, focused)

  const card = session.cards.find((item) => item.cardId === cardId)
  const references = card?.kind === 'prompt' ? (card.references ?? []) : []
  const catalogLoaded = session.catalogStatus === 'ready' || session.catalogStatus === 'empty'
  const chipViews = promptReferenceChipViews(
    session.cards,
    { cardId, references },
    catalogLoaded ? (sourceId) => sourceFactsOf(session, sourceId).readable : undefined
  )
  const issue = promptReferenceIssueSummary(chipViews)
  const saveFailure = session.saveError
    ? promptReferenceFailureOf({
        code: session.saveError.code,
        message: session.saveError.msg
      })
    : null
  const alert = session.promptReferenceAlert
  const cardAlert = alert && (alert.cardId === undefined || alert.cardId === cardId) ? alert : null
  const externalFailure = cardAlert?.message ?? null
  const cardScopedAlert = cardAlert?.cardId === cardId
  const displayedAlert: DisplayedAlert | null = issue
    ? { text: issue.text, tone: issue.tone, removableIds: issue.removableIds }
    : saveFailure && references.length > 0
      ? { text: saveFailure.text, tone: 'danger', removableIds: [] }
      : externalFailure && (cardScopedAlert || references.length > 0)
        ? { text: externalFailure, tone: 'danger', removableIds: [] }
        : null

  const candidates = mention
    ? promptReferenceCandidates(session.cards, cardId, {
        query: mention.query,
        referencedIds: references.map((reference) => reference.cardId),
        isSourceReadable: (sourceId) => sourceFactsOf(session, sourceId).readable
      })
    : []

  useLayoutEffect(() => {
    if (!editing) return
    const element = area.current
    if (!element) return
    const end = element.value.length
    element.focus()
    element.setSelectionRange(end, end)
    element.scrollTop = element.scrollHeight
  }, [editing])

  useLayoutEffect(() => {
    const caret = pendingCaret.current
    if (caret === null) return
    const element = area.current
    if (!element || !editing || document.activeElement !== element) {
      pendingCaret.current = null
      pendingScroll.current = null
      return
    }
    pendingCaret.current = null
    const scrollTop = pendingScroll.current
    pendingScroll.current = null
    const next = Math.max(0, Math.min(caret, element.value.length))
    element.focus()
    element.setSelectionRange(next, next)
    if (scrollTop !== null) element.scrollTop = scrollTop
  }, [value, editing])

  useEffect(() => {
    if (editing) return
    const element = display.current
    if (!element) return
    const update = (): void => {
      const remaining = element.scrollHeight - element.scrollTop - element.clientHeight
      setDisplayFade(element.scrollHeight > element.clientHeight + 1 && remaining > 2)
    }
    update()
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(update)
    observer?.observe(element)
    element.addEventListener('scroll', update, { passive: true })
    return () => {
      observer?.disconnect()
      element.removeEventListener('scroll', update)
    }
  }, [editing, value])

  // 取消浮层只清理本次触发文本并复位光标，不插入引用；光标已离开触发词时用浮层记录的范围兜底。
  const cancelMention = useCallback((): void => {
    setMention(null)
    setPickerPosition(null)
    const element = area.current
    if (!element) return
    const text = element.value
    const caret = element.selectionStart ?? text.length
    const fallback =
      mention && text.slice(mention.start, mention.end) === `@${mention.query}` ? mention : null
    const current = promptMentionAt(text, caret) ?? fallback
    if (!current) return
    const next = removePromptMentionText(text, current)
    commands.editPromptBody(cardId, next.value)
    pendingCaret.current = next.caret
    pendingScroll.current = element.scrollTop
  }, [cardId, commands, mention])

  useEffect(() => {
    if (!mention) return
    const onScroll = (event: Event): void => {
      const target = event.target
      if (!(target instanceof Node)) return
      if (area.current?.contains(target) || picker.current?.contains(target)) return
      cancelMention()
    }
    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target
      if (!(target instanceof Node)) return
      if (area.current?.contains(target) || picker.current?.contains(target)) return
      cancelMention()
    }
    window.addEventListener('resize', cancelMention)
    window.addEventListener('scroll', onScroll, true)
    window.addEventListener('pointerdown', onPointerDown, true)
    return () => {
      window.removeEventListener('resize', cancelMention)
      window.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('pointerdown', onPointerDown, true)
    }
  }, [mention, cancelMention])

  function positionPicker(): void {
    const element = area.current
    if (!element) {
      setPickerPosition(null)
      return
    }
    const rect = element.getBoundingClientRect()
    const width = Math.min(Math.max(rect.width, 288), 360)
    const estimatedHeight = 286
    const below = rect.bottom + 8
    const above = rect.top - estimatedHeight - 8
    setPickerPosition({
      top: below + estimatedHeight <= window.innerHeight ? below : Math.max(8, above),
      left: Math.min(Math.max(8, rect.left), Math.max(8, window.innerWidth - width - 8)),
      width
    })
  }

  function syncMention(nextValue: string, caret: number | null): void {
    const next = caret === null ? null : promptMentionAt(nextValue, caret)
    setActiveIndex(0)
    setMention(next)
    if (next) positionPicker()
    else setPickerPosition(null)
  }

  function exitEditing(): void {
    if (mention) cancelMention()
    setFocused(false)
    setMention(null)
    setPickerPosition(null)
    void commands.flushPromptEdits()
    onExitEditing()
  }

  function choose(candidate: PromptReferenceCandidate): void {
    const element = area.current
    const text = element?.value ?? value
    const currentMention = element
      ? promptMentionAt(text, element.selectionStart ?? text.length)
      : mention
    if (currentMention) {
      const next = removePromptMentionText(text, currentMention)
      commands.editPromptBody(cardId, next.value)
      pendingCaret.current = next.caret
      pendingScroll.current = element?.scrollTop ?? null
    }
    commands.addPromptReference(cardId, candidate.cardId)
    setMention(null)
    element?.focus()
  }

  function handleKeyDown(event: ReactKeyboardEvent<HTMLTextAreaElement>): void {
    if (event.nativeEvent.isComposing) return
    if (event.key === 'Escape') {
      event.preventDefault()
      if (mention) {
        cancelMention()
        return
      }
      exitEditing()
      return
    }
    if (!mention) return
    if (candidates.length === 0) return
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setActiveIndex((index) => (index + 1) % candidates.length)
      return
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault()
      setActiveIndex((index) => (index - 1 + candidates.length) % candidates.length)
      return
    }
    if (event.key === 'Enter') {
      event.preventDefault()
      choose(candidates[activeIndex] ?? candidates[0])
    }
  }

  const empty = value.trim().length === 0

  return (
    <div
      ref={root}
      className={`${styles.prompt}${editing ? ' nodrag nopan nowheel' : ''}`}
      data-prompt-focused={focused}
    >
      <span className={styles.promptHalo} data-prompt-halo aria-hidden="true" />
      <div className={styles.promptField}>
        {editing ? (
          <textarea
            ref={area}
            className={styles.promptArea}
            value={value}
            rows={1}
            data-selectable
            role="combobox"
            aria-label="提示词正文"
            aria-autocomplete="list"
            aria-expanded={mention !== null}
            aria-controls={mention && candidates.length > 0 ? listId : undefined}
            aria-activedescendant={
              mention && candidates.length > 0 ? `${listId}-${activeIndex}` : undefined
            }
            placeholder="写下这次的想法…输入 @ 引用卡片"
            onFocus={() => setFocused(true)}
            onBlur={(event) => {
              const next = event.relatedTarget
              if (next instanceof Node && picker.current?.contains(next)) return
              exitEditing()
            }}
            onChange={(event) => {
              const next = event.target.value
              commands.editPromptBody(cardId, next)
              syncMention(next, event.target.selectionStart)
            }}
            onKeyDown={handleKeyDown}
            onKeyUp={(event) => {
              if (!mention) return
              if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
              const element = event.currentTarget
              syncMention(element.value, element.selectionStart)
            }}
            onClick={(event) => {
              if (!mention) return
              syncMention(event.currentTarget.value, event.currentTarget.selectionStart)
            }}
          />
        ) : (
          <div
            ref={display}
            className={`${styles.promptDisplay} nowheel`}
            data-empty={empty || undefined}
            data-fade={displayFade || undefined}
            aria-label="提示词正文"
          >
            {empty ? '写下这次的想法…双击编辑，输入 @ 引用卡片' : value}
          </div>
        )}
        {chipViews.length > 0 ? (
          <div
            className={`${styles.promptRefs} nodrag nopan`}
            aria-label={`提示词已引用 ${chipViews.length} 张画布卡片`}
            onDoubleClick={(event) => event.stopPropagation()}
          >
            <span className={styles.promptRefsLabel}>引用</span>
            <ul className={styles.promptRefList}>
              {chipViews.map((view) => (
                <li key={`${view.cardId}:${view.issue?.kind ?? 'valid'}`}>
                  <span
                    className={styles.promptRefChip}
                    data-tone={view.tone}
                    title={view.detail ?? view.displayName}
                  >
                    {view.tone === 'valid' ? (
                      <span className={styles.promptRefAt} aria-hidden="true">
                        @
                      </span>
                    ) : (
                      <CardAlertIcon className={styles.promptRefWarn} />
                    )}
                    <span className={styles.promptRefName}>{view.displayName}</span>
                    {view.kindLabel && view.tone === 'valid' ? (
                      <span className={styles.promptRefKind}>{view.kindLabel}</span>
                    ) : null}
                    <button
                      className={styles.promptRefRemove}
                      type="button"
                      aria-label={`移除引用 ${view.displayName}`}
                      title="移除引用"
                      onClick={() => commands.removePromptReferences(cardId, [view.cardId])}
                    >
                      <CardClearIcon />
                    </button>
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>
      {displayedAlert ? (
        <p
          className={`${styles.promptRefAlert} nodrag nopan`}
          data-tone={displayedAlert.tone}
          role="alert"
          onDoubleClick={(event) => event.stopPropagation()}
        >
          <CardAlertIcon className={styles.promptRefAlertIcon} />
          <span className={styles.promptRefAlertText}>{displayedAlert.text}</span>
          {displayedAlert.removableIds.length > 0 ? (
            <button
              className={styles.promptRefAlertAction}
              type="button"
              onClick={() => commands.removePromptReferences(cardId, displayedAlert.removableIds)}
            >
              移除失效引用
            </button>
          ) : null}
        </p>
      ) : null}
      {mention && pickerPosition
        ? createPortal(
            <div
              ref={picker}
              className={`${styles.promptPicker} nodrag nopan nowheel`}
              data-testid="prompt-reference-picker"
              onDoubleClick={(event) => event.stopPropagation()}
              style={{
                top: pickerPosition.top,
                left: pickerPosition.left,
                width: pickerPosition.width
              }}
            >
              <div className={styles.promptPickerHead}>
                <span className={styles.promptPickerTitle}>引用当前画布</span>
                <span className={styles.promptPickerQuery} aria-hidden="true">
                  @{mention.query}
                </span>
              </div>
              {candidates.length === 0 ? (
                <p className={styles.promptPickerEmpty}>
                  {mention.query.trim().length > 0
                    ? `没有匹配「${mention.query.trim()}」的卡片`
                    : '当前画布没有其他可引用卡片'}
                </p>
              ) : (
                <div className={styles.promptPickerList} id={listId} role="listbox">
                  {candidates.map((candidate, index) => (
                    <button
                      key={candidate.cardId}
                      id={`${listId}-${index}`}
                      className={styles.promptPickerOption}
                      data-active={index === activeIndex}
                      type="button"
                      role="option"
                      aria-selected={index === activeIndex}
                      onMouseEnter={() => setActiveIndex(index)}
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={() => choose(candidate)}
                    >
                      <span className={styles.promptPickerOptionIcon} data-kind={candidate.kind}>
                        <ContentKindIcon
                          contentKind={candidate.contentKind}
                          {...(candidate.textKind === undefined
                            ? {}
                            : { textKind: candidate.textKind })}
                        />
                      </span>
                      <span className={styles.promptPickerOptionCopy}>
                        <span className={styles.promptPickerOptionName}>
                          {candidate.displayName}
                        </span>
                        <span className={styles.promptPickerOptionMeta}>{candidate.detail}</span>
                      </span>
                      <span className={styles.promptPickerOptionKind}>{candidate.kindLabel}</span>
                    </button>
                  ))}
                </div>
              )}
              <div className={styles.promptPickerFoot}>
                <span>↑↓ 选择</span>
                <span>Enter 引用</span>
                <span>Esc 关闭</span>
              </div>
            </div>,
            document.body
          )
        : null}
    </div>
  )
}
