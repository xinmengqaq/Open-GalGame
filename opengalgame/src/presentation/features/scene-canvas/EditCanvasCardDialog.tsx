import { useEffect, useState, type ReactElement } from 'react'

import { Button } from '../../components/Button'
import { Dialog } from '../../components/Dialog'
import { FormField, TextArea, TextInput } from '../../components/FormField'
import { Select } from '../../components/Select'
import { workbenchFeedback } from '../../feedback/workbenchFeedback'
import { cardKindLabel } from '../workbench-session/contentKindLabel'
import { useWorkbenchCommands } from '../workbench-session/workbenchCommandsContext'
import type {
  SessionCard,
  SessionFieldCard,
  SessionSourceCard
} from '../workbench-session/workbenchSession.types'
import {
  presetDescriptionOf,
  presetLabelOf,
  presetOptionsFor
} from '../workbench-session/webgalPreset'
import styles from './SceneCanvas.module.css'

interface EditCanvasCardDialogProps {
  card: SessionCard | null
  onClose: () => void
}

/** 媒体卡用途说明的示例；文档仍用简介，不显示这段提示。 */
const mediaSummaryHints: Record<Exclude<SessionSourceCard['kind'], 'document'>, string> = {
  image: '例如：背景、立绘、CG、头像。生成时会按这段说明选用这张图片。',
  audio: '例如：片尾音乐、点击音效、角色配音。生成时会按这段说明选用这段音频。',
  video: '例如：开场动画、过场镜头、结局 CG。生成时会按这段说明选用这段视频。'
}

/** 按卡片类别只呈现该类别拥有的字段。取消不产生请求。 */
export function EditCanvasCardDialog({ card, onClose }: EditCanvasCardDialogProps): ReactElement {
  if (!card || card.kind === 'prompt') {
    return (
      <Dialog open={false} title="编辑输入卡片" allowClose onClose={onClose} actions={null}>
        {null}
      </Dialog>
    )
  }
  return <EditCardForm key={card.cardId} card={card} onClose={onClose} />
}

function EditCardForm({ card, onClose }: { card: SessionCard; onClose: () => void }): ReactElement {
  if (card.kind === 'animation' || card.kind === 'effect') {
    return <FieldCardForm card={card} onClose={onClose} />
  }
  if (card.kind === 'prompt') {
    return (
      <Dialog open={false} title="编辑输入卡片" allowClose onClose={onClose} actions={null}>
        {null}
      </Dialog>
    )
  }
  return <TitleCardForm card={card} onClose={onClose} />
}

function TitleCardForm({
  card,
  onClose
}: {
  card: SessionSourceCard
  onClose: () => void
}): ReactElement {
  const commands = useWorkbenchCommands()
  const summaryHint = card.kind === 'document' ? null : mediaSummaryHints[card.kind]
  const [title, setTitle] = useState(card.title)
  const [summary, setSummary] = useState(card.summary)
  const [error, setError] = useState<string | undefined>()
  const [applying, setApplying] = useState(false)

  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      const input = document.getElementById('edit-card-title')
      if (input instanceof HTMLInputElement) input.focus({ preventScroll: true })
    })
    return () => cancelAnimationFrame(frame)
  }, [])

  async function submit(): Promise<void> {
    const nextTitle = title.trim()
    if (!nextTitle) {
      setError(workbenchFeedback.titleBlank)
      return
    }
    const nextSummary = summary.trim()
    const unchanged = nextTitle === card.title && nextSummary === card.summary
    if (unchanged) {
      onClose()
      return
    }
    setApplying(true)
    setError(undefined)
    const applied = await commands.editCard(card.cardId, {
      title: nextTitle,
      summary: nextSummary
    })
    setApplying(false)
    if (applied === 'applied') onClose()
    else if (applied === 'failed') setError(workbenchFeedback.editNotApplied)
  }

  return (
    <Dialog
      open
      title="编辑输入卡片"
      allowClose
      onClose={onClose}
      actions={
        <>
          <Button variant="secondary" onClick={onClose} disabled={applying}>
            取消
          </Button>
          <Button onClick={() => void submit()} disabled={applying}>
            {applying ? '正在应用' : '应用'}
          </Button>
        </>
      }
    >
      <div className={styles.editIntro}>
        <span className={styles.editKind}>{cardKindLabel(card.kind)}</span>
        <p>{workbenchFeedback.sessionEdit}</p>
      </div>
      <FormField label="标题" htmlFor="edit-card-title" error={error}>
        <TextInput
          id="edit-card-title"
          value={title}
          aria-invalid={Boolean(error)}
          onChange={(event) => {
            setTitle(event.target.value)
            if (error) setError(undefined)
          }}
        />
      </FormField>
      <FormField
        label={summaryHint ? '用途说明' : '简介'}
        htmlFor="edit-card-summary"
        optional="可空"
      >
        <TextArea
          id="edit-card-summary"
          value={summary}
          rows={4}
          aria-describedby={summaryHint ? 'edit-card-purpose-hint' : undefined}
          onChange={(event) => setSummary(event.target.value)}
        />
      </FormField>
      {summaryHint ? (
        <p id="edit-card-purpose-hint" className={styles.purposeHint}>
          {summaryHint}
        </p>
      ) : null}
    </Dialog>
  )
}

function FieldCardForm({
  card,
  onClose
}: {
  card: SessionFieldCard
  onClose: () => void
}): ReactElement {
  const commands = useWorkbenchCommands()
  const [selectedName, setSelectedName] = useState(card.webgalPreset?.name ?? 'none')
  const [error, setError] = useState<string | null>(null)
  const [applying, setApplying] = useState(false)
  const options: { value: string; label: string }[] = presetOptionsFor(card.kind).map((option) => ({
    value: option.binding.name,
    label: option.label
  }))
  if (card.webgalPreset && !options.some((option) => option.value === card.webgalPreset?.name)) {
    options.unshift({
      value: card.webgalPreset.name,
      label: presetLabelOf(card.kind, card.webgalPreset.name)
    })
  }
  options.unshift({ value: 'none', label: '未绑定预设' })
  const description = selectedName === 'none' ? null : presetDescriptionOf(card.kind, selectedName)

  async function submit(): Promise<void> {
    const nextPreset =
      selectedName === 'none'
        ? null
        : (presetOptionsFor(card.kind).find((option) => option.binding.name === selectedName)
            ?.binding ??
          (card.webgalPreset?.name === selectedName ? { ...card.webgalPreset } : null))
    const unchanged =
      (nextPreset?.name ?? null) === (card.webgalPreset?.name ?? null) &&
      (nextPreset?.command ?? null) === (card.webgalPreset?.command ?? null)
    if (unchanged) {
      onClose()
      return
    }
    setApplying(true)
    setError(null)
    const applied = await commands.bindFieldCardPreset(card.cardId, nextPreset)
    setApplying(false)
    if (applied === 'applied') onClose()
    else if (applied === 'failed') setError('预设没有应用，请稍后重试。')
  }

  return (
    <Dialog
      open
      title={`编辑${cardKindLabel(card.kind)}卡`}
      allowClose
      onClose={onClose}
      actions={
        <>
          <Button variant="secondary" onClick={onClose} disabled={applying}>
            取消
          </Button>
          <Button onClick={() => void submit()} disabled={applying}>
            {applying ? '正在应用' : '应用'}
          </Button>
        </>
      }
    >
      <div className={styles.editIntro}>
        <span className={styles.editKind}>{cardKindLabel(card.kind)}</span>
        <p>{workbenchFeedback.sessionEdit}</p>
      </div>
      <FormField label="预设" htmlFor="edit-card-preset">
        <Select
          id="edit-card-preset"
          value={selectedName}
          options={options}
          onChange={(value) => {
            setSelectedName(value)
            if (error) setError(null)
          }}
        />
      </FormField>
      <p className={styles.presetDescription}>
        {description ?? '还没有选择预设。动画与特效的选项不会混用。'}
      </p>
      {error ? (
        <p className={styles.dialogError} role="alert">
          {error}
        </p>
      ) : null}
    </Dialog>
  )
}
