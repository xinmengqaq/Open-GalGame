import { clsx } from 'clsx'
import { LockKeyhole, LocateFixed, Pencil, TriangleAlert } from 'lucide-react'
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactElement,
  type ReactNode
} from 'react'

import type { PreviewPhase } from '@application/scene-preview/vo/PreviewRuntimeVO'
import type {
  SceneDialogueVO,
  ScenePreviewIssueVO,
  ScenePreviewLockState
} from '@application/scene-preview/vo/ScenePreviewSessionVO'
import { prefersReducedMotion } from '@presentation/effects/motion'

import { PreviewIssuesPopover } from './PreviewIssuesPopover'
import styles from './PreviewDialogueList.module.css'

interface PreviewDialogueListProps {
  readonly dialogues: readonly SceneDialogueVO[]
  readonly texts: Readonly<Record<string, string>>
  readonly dirtyIds: readonly string[]
  readonly blankIds: readonly string[]
  readonly issues: readonly ScenePreviewIssueVO[]
  readonly selectedDialogueId: string | null
  readonly editingDialogueId: string | null
  readonly positionDialogueId: string | null
  readonly phase: PreviewPhase
  readonly lockState: ScenePreviewLockState
  readonly followEnabled: boolean
  readonly followAvailable: boolean
  readonly canEditDialogue: (dialogueId: string) => boolean
  readonly onSelectDialogue: (dialogueId: string) => void
  readonly onStartEditing: (dialogueId: string) => void
  readonly onFinishEditing: () => void
  readonly onChangeText: (dialogueId: string, text: string) => void
  readonly onFollowOn: () => void
  readonly onFollowOff: () => void
  readonly notice?: ReactNode
}

export function PreviewDialogueList({
  dialogues,
  texts,
  dirtyIds,
  blankIds,
  issues,
  selectedDialogueId,
  editingDialogueId,
  positionDialogueId,
  phase,
  lockState,
  followEnabled,
  followAvailable,
  canEditDialogue,
  onSelectDialogue,
  onStartEditing,
  onFinishEditing,
  onChangeText,
  onFollowOn,
  onFollowOff,
  notice
}: PreviewDialogueListProps): ReactElement {
  const listRef = useRef<HTMLDivElement>(null)
  const programmaticUntil = useRef(0)
  const issuesTriggerRef = useRef<HTMLButtonElement>(null)
  const [issuesOpen, setIssuesOpen] = useState(false)

  const positionIndex = dialogues.findIndex(
    (dialogue) => dialogue.dialogueId === positionDialogueId
  )
  const positionNumber = positionIndex < 0 ? null : positionIndex + 1

  useEffect(() => {
    if (!followAvailable || !followEnabled || positionDialogueId === null) return
    const list = listRef.current
    if (list === null) return
    const active = document.activeElement
    if (active instanceof HTMLTextAreaElement && list.contains(active)) return
    const row = Array.from(list.querySelectorAll<HTMLElement>('[data-dialogue-id]')).find(
      (element) => element.dataset.dialogueId === positionDialogueId
    )
    if (row === undefined) return
    programmaticUntil.current = Date.now() + 900
    list.scrollTo({
      top: Math.max(0, row.offsetTop - (list.clientHeight - row.offsetHeight) / 2),
      behavior: prefersReducedMotion() ? 'auto' : 'smooth'
    })
  }, [dialogues, followAvailable, followEnabled, positionDialogueId])

  useEffect(() => {
    if (editingDialogueId === null) return
    const list = listRef.current
    if (list === null) return
    const row = Array.from(list.querySelectorAll<HTMLElement>('[data-dialogue-id]')).find(
      (element) => element.dataset.dialogueId === editingDialogueId
    )
    if (row === undefined) return
    const rowTop = row.offsetTop
    const rowBottom = rowTop + row.offsetHeight
    if (rowTop < list.scrollTop || rowBottom > list.scrollTop + list.clientHeight) {
      programmaticUntil.current = Date.now() + 500
      list.scrollTo({
        top: Math.max(0, rowTop - (list.clientHeight - row.offsetHeight) / 2),
        behavior: prefersReducedMotion() ? 'auto' : 'smooth'
      })
    }
  }, [editingDialogueId])

  const dirtySet = new Set(dirtyIds)
  const blankSet = new Set(blankIds)
  const issuesByDialogue = new Map<string, number>()
  for (const issue of issues) {
    if (issue.dialogueId === undefined) continue
    issuesByDialogue.set(issue.dialogueId, (issuesByDialogue.get(issue.dialogueId) ?? 0) + 1)
  }

  return (
    <section className={styles.panel} aria-label="台词" data-testid="preview-dialogue-list">
      <header className={styles.head}>
        <div className={styles.titleRow}>
          <h2>台词</h2>
          <span className={styles.count}>{dialogues.length} 句</span>
          <div className={styles.headActions}>
            {issues.length > 0 ? (
              <button
                ref={issuesTriggerRef}
                type="button"
                className={clsx(styles.issueTrigger, issuesOpen && styles.issueTriggerOpen)}
                aria-expanded={issuesOpen}
                aria-haspopup="dialog"
                onClick={() => setIssuesOpen((open) => !open)}
              >
                <TriangleAlert size={12} strokeWidth={2} />
                {issues.length} 处提示
              </button>
            ) : null}
            {lockState !== 'editable' ? (
              <span className={styles.lockChip}>
                <LockKeyhole size={11} strokeWidth={2} />
                只读
              </span>
            ) : null}
          </div>
        </div>
        <p className={clsx(styles.note, blankIds.length > 0 && styles.noteWarning)}>
          {lockState === 'locked'
            ? '这个场景正在别处编辑，当前只能查看。'
            : lockState === 'unknown'
              ? '无法确认场景是否可编辑，已按只读处理。'
              : blankIds.length > 0
                ? `有 ${blankIds.length} 处台词为空，补上后才能保存。`
                : '只修改文字 · 说话人和配音保持原样'}
        </p>
        {issuesOpen ? (
          <PreviewIssuesPopover
            issues={issues}
            dialogues={dialogues}
            anchorRef={issuesTriggerRef}
            onClose={() => setIssuesOpen(false)}
            onSelectDialogue={onSelectDialogue}
          />
        ) : null}
      </header>

      {notice}

      <div
        ref={listRef}
        className={styles.list}
        onScroll={() => {
          if (Date.now() < programmaticUntil.current) return
          if (followEnabled) onFollowOff()
        }}
      >
        {dialogues.length === 0 ? (
          <p className={styles.empty}>这个场景还没有可试玩的台词。</p>
        ) : null}
        {dialogues.map((dialogue, index) => (
          <DialogueRow
            key={dialogue.dialogueId}
            dialogue={dialogue}
            index={index}
            text={texts[dialogue.dialogueId] ?? dialogue.text}
            dirty={dirtySet.has(dialogue.dialogueId)}
            blank={blankSet.has(dialogue.dialogueId)}
            issueCount={issuesByDialogue.get(dialogue.dialogueId) ?? 0}
            selected={selectedDialogueId === dialogue.dialogueId}
            editing={editingDialogueId === dialogue.dialogueId}
            atPosition={positionDialogueId === dialogue.dialogueId}
            playing={phase === 'playing'}
            editable={canEditDialogue(dialogue.dialogueId)}
            onSelect={onSelectDialogue}
            onStartEditing={onStartEditing}
            onFinishEditing={onFinishEditing}
            onChangeText={onChangeText}
          />
        ))}
        <div className={styles.listTail} aria-hidden="true" />
      </div>

      {followAvailable && !followEnabled && positionNumber !== null ? (
        <button type="button" className={styles.followChip} onClick={onFollowOn}>
          <LocateFixed size={14} strokeWidth={2} />
          回到第 {positionNumber} 句
        </button>
      ) : null}
    </section>
  )
}

interface DialogueRowProps {
  readonly dialogue: SceneDialogueVO
  readonly index: number
  readonly text: string
  readonly dirty: boolean
  readonly blank: boolean
  readonly issueCount: number
  readonly selected: boolean
  readonly editing: boolean
  readonly atPosition: boolean
  readonly playing: boolean
  readonly editable: boolean
  readonly onSelect: (dialogueId: string) => void
  readonly onStartEditing: (dialogueId: string) => void
  readonly onFinishEditing: () => void
  readonly onChangeText: (dialogueId: string, text: string) => void
}

function DialogueRow({
  dialogue,
  index,
  text,
  dirty,
  blank,
  issueCount,
  selected,
  editing,
  atPosition,
  playing,
  editable,
  onSelect,
  onStartEditing,
  onFinishEditing,
  onChangeText
}: DialogueRowProps): ReactElement {
  const rowRef = useRef<HTMLDivElement>(null)
  const selectRef = useRef<HTMLButtonElement>(null)
  const editorRef = useRef<HTMLTextAreaElement>(null)
  const composingRef = useRef(false)
  const [composingValue, setComposingValue] = useState<string | null>(null)

  useEffect(() => {
    if (!editing) return
    const editor = editorRef.current
    if (editor === null) return
    editor.focus({ preventScroll: true })
    editor.setSelectionRange(editor.value.length, editor.value.length)
  }, [editing])

  useLayoutEffect(() => {
    const editor = editorRef.current
    if (editor === null) return
    editor.style.height = 'auto'
    editor.style.height = `${editor.scrollHeight}px`
  }, [composingValue, editing, text])

  const resize = (editor: HTMLTextAreaElement): void => {
    editor.style.height = 'auto'
    editor.style.height = `${editor.scrollHeight}px`
  }

  const finishAndFocusRow = (): void => {
    onFinishEditing()
    window.requestAnimationFrame(() => {
      const active = document.activeElement
      if (
        active !== null &&
        active !== document.body &&
        !(active instanceof HTMLElement && rowRef.current?.contains(active))
      ) {
        return
      }
      selectRef.current?.focus({ preventScroll: true })
    })
  }

  const enterEditing = (): void => {
    if (editable) {
      onStartEditing(dialogue.dialogueId)
      return
    }
    onSelect(dialogue.dialogueId)
  }

  return (
    <div
      ref={rowRef}
      data-dialogue-id={dialogue.dialogueId}
      className={clsx(
        styles.row,
        selected && styles.rowSelected,
        editing && styles.rowEditing,
        atPosition && styles.rowPosition,
        blank && styles.rowInvalid
      )}
      aria-current={atPosition ? 'true' : undefined}
    >
      <span className={styles.rail} aria-hidden="true">
        {atPosition ? (
          <span
            className={clsx(styles.positionMark, playing && styles.positionBars)}
            title="舞台当前位置"
          >
            {playing ? (
              <>
                <span />
                <span />
                <span />
              </>
            ) : null}
          </span>
        ) : null}
        {atPosition && playing ? null : String(index + 1).padStart(2, '0')}
      </span>

      <div className={styles.body}>
        {editing ? (
          <>
            <textarea
              ref={editorRef}
              className={styles.editor}
              value={composingValue ?? text}
              rows={1}
              spellCheck={false}
              aria-label={`编辑第 ${index + 1} 句`}
              onChange={(event) => {
                resize(event.currentTarget)
                const nativeEvent = event.nativeEvent
                const composing = 'isComposing' in nativeEvent && nativeEvent.isComposing === true
                if (composingRef.current || composing) {
                  setComposingValue(event.currentTarget.value)
                  return
                }
                onChangeText(dialogue.dialogueId, event.currentTarget.value)
              }}
              onCompositionStart={() => {
                composingRef.current = true
              }}
              onCompositionEnd={(event) => {
                composingRef.current = false
                setComposingValue(null)
                resize(event.currentTarget)
                onChangeText(dialogue.dialogueId, event.currentTarget.value)
              }}
              onBlur={(event) => {
                if (composingRef.current) {
                  composingRef.current = false
                  setComposingValue(null)
                  onChangeText(dialogue.dialogueId, event.currentTarget.value)
                }
                onFinishEditing()
              }}
              onKeyDown={(event) => {
                if (event.nativeEvent.isComposing) return
                if (event.key === 'Escape') {
                  event.preventDefault()
                  finishAndFocusRow()
                  return
                }
                if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
                  event.preventDefault()
                  finishAndFocusRow()
                }
              }}
            />
            {blank ? <span className={styles.invalidHint}>台词不能为空</span> : null}
          </>
        ) : (
          <>
            <button
              ref={selectRef}
              type="button"
              className={styles.selectArea}
              aria-label={`第 ${index + 1} 句${dirty ? '（有未保存修改）' : ''}${
                atPosition ? '（舞台当前位置）' : ''
              }${editable ? '，按回车编辑' : ''}：${text.trim() === '' ? '空白台词' : text}`}
              aria-pressed={selected}
              onClick={enterEditing}
            >
              <span className={clsx(styles.text, text.trim() === '' && styles.textBlank)}>
                {text.trim() === '' ? '（空白台词）' : text}
              </span>
            </button>
            {blank ? <span className={styles.invalidHint}>台词不能为空</span> : null}
          </>
        )}
      </div>

      <div className={styles.tail}>
        {dirty ? <span className={styles.dirtyMark} title="已修改" aria-label="已修改" /> : null}
        {issueCount > 0 ? (
          <span className={styles.issueMark} title={`${issueCount} 处预览提示`} />
        ) : null}
        {editable && !editing ? (
          <button
            type="button"
            className={styles.editButton}
            aria-label={`编辑第 ${index + 1} 句`}
            title="编辑这一句"
            onClick={() => onStartEditing(dialogue.dialogueId)}
          >
            <Pencil size={12} strokeWidth={1.9} />
          </button>
        ) : null}
      </div>
    </div>
  )
}
