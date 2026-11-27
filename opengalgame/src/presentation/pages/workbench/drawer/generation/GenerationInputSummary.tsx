import {
  ArrowRight,
  Check,
  CircleAlert,
  Layers,
  Link2,
  LockKeyhole,
  ShieldCheck
} from 'lucide-react'
import { useId, type ReactElement } from 'react'

import type { SceneGenerationRenderStatusVO } from '@application/scene-generation/vo/SceneGenerationRenderVO'
import { Popover, PopoverContent, PopoverTrigger } from '@presentation/components/ui/popover'
import { ContentKindIcon } from '@presentation/features/workbench-session/ContentKindIcon'
import { presetLabelOf } from '@presentation/features/workbench-session/webgalPreset'
import type { SessionCard } from '@presentation/features/workbench-session/workbenchSession.types'
import { CountUp } from '../CountUp'
import {
  countCanvasCards,
  countStatusInputs,
  type InputSummaryEntry
} from './generationPresentation'

const SEGMENT_COLORS = [
  'var(--type-document)',
  'var(--type-image)',
  'var(--type-audio)',
  'var(--type-video)',
  'var(--type-prompt)',
  'var(--purple-deep)',
  'var(--teal)'
] as const
const ENTRY_COLORS: Readonly<Record<string, string>> = {
  document: 'var(--type-document)',
  documentCount: 'var(--type-document)',
  image: 'var(--type-image)',
  audio: 'var(--type-audio)',
  video: 'var(--type-video)',
  prompt: 'var(--purple-deep)',
  promptCount: 'var(--purple-deep)',
  assetCount: 'var(--type-image)',
  relationCount: 'var(--type-audio)',
  confirmedControlCount: 'var(--positive)',
  fieldBindingCount: 'var(--type-animation)',
  animation: 'var(--type-animation)',
  effect: 'var(--type-effect)'
}
const DONUT_RADIUS = 62
const DONUT_CIRCUMFERENCE = 2 * Math.PI * DONUT_RADIUS

function isFieldKind(key: string): boolean {
  return key === 'animation' || key === 'effect'
}

function isFieldBindingKey(key: string): boolean {
  return key === 'fieldBindingCount'
}

function colorAt(entry: InputSummaryEntry, index: number): string {
  return (
    ENTRY_COLORS[entry.key] ?? SEGMENT_COLORS[index % SEGMENT_COLORS.length] ?? SEGMENT_COLORS[0]
  )
}

function excerpt(text: string, max: number): string {
  const trimmed = text.trim()
  return trimmed.length > max ? `${trimmed.slice(0, max).trimEnd()}…` : trimmed
}

function InputKindIcon({ kind }: { kind: string }): ReactElement {
  switch (kind) {
    case 'document':
    case 'documentCount':
      return <ContentKindIcon contentKind="text" textKind="document" />
    case 'prompt':
    case 'promptCount':
      return <ContentKindIcon contentKind="text" textKind="prompt" />
    case 'image':
      return <ContentKindIcon contentKind="image" />
    case 'audio':
      return <ContentKindIcon contentKind="audio" />
    case 'video':
      return <ContentKindIcon contentKind="video" />
    case 'animation':
      return <ContentKindIcon contentKind="animation" />
    case 'effect':
      return <ContentKindIcon contentKind="effect" />
    case 'relationCount':
      return <Link2 />
    case 'confirmedControlCount':
      return <ShieldCheck />
    case 'assetCount':
    default:
      return <Layers />
  }
}

type CardRowView = {
  kind: SessionCard['kind']
  title: string
  detailLabel: '用途' | '说明' | '正文' | null
  detail: string | null
  detailMissing: boolean
  flag: string | null
  command: string | null
}

function cardRowViewOf(card: SessionCard): CardRowView {
  if (card.kind === 'prompt') {
    const body = card.body.trim()
    if (body === '') {
      return {
        kind: card.kind,
        title: '还没有写提示词',
        detailLabel: null,
        detail: null,
        detailMissing: false,
        flag: '空提示词',
        command: null
      }
    }
    const firstLine = body.split(/\r?\n/).find((line) => line.trim().length > 0) ?? body
    const rest = body.slice(body.indexOf(firstLine) + firstLine.length).trim()
    const afterTitle = firstLine.length > 40 ? firstLine.slice(40) : ''
    const continuation = [afterTitle, rest].filter((part) => part !== '').join('\n')
    return {
      kind: card.kind,
      title: excerpt(firstLine, 40),
      detailLabel: continuation === '' ? null : '正文',
      detail:
        continuation === ''
          ? null
          : `${firstLine.length > 40 ? '…' : ''}${excerpt(continuation, 200)}`,
      detailMissing: false,
      flag: null,
      command: null
    }
  }
  if (card.kind === 'animation' || card.kind === 'effect') {
    const preset = card.webgalPreset
    if (preset === null) {
      return {
        kind: card.kind,
        title: '未选择预设',
        detailLabel: null,
        detail: '这张字段卡片还没有绑定命令。',
        detailMissing: true,
        flag: '待绑定',
        command: null
      }
    }
    return {
      kind: card.kind,
      title: presetLabelOf(card.kind, preset.name),
      detailLabel: null,
      detail: null,
      detailMissing: false,
      flag: null,
      command: preset.command
    }
  }
  const summary = card.summary.trim()
  const missing = summary === ''
  const isDocument = card.kind === 'document'
  return {
    kind: card.kind,
    title: card.title,
    detailLabel: isDocument ? '说明' : '用途',
    detail: missing ? (isDocument ? '未写说明' : '未填写用途说明') : excerpt(summary, 200),
    detailMissing: missing,
    flag: missing && !isDocument ? '用途待补' : null,
    command: null
  }
}

function CardRow({ card }: { card: SessionCard }): ReactElement {
  const view = cardRowViewOf(card)
  return (
    <li className="wb-gen-summary__row" data-kind={view.kind}>
      <span aria-hidden="true" className="wb-gen-summary__row-icon" data-kind={view.kind}>
        <InputKindIcon kind={view.kind} />
      </span>
      <span className="wb-gen-summary__row-main">
        <span className="wb-gen-summary__row-head">
          <span className="wb-gen-summary__row-title" title={view.title}>
            {view.title}
          </span>
          {view.flag ? <span className="wb-gen-summary__row-flag">{view.flag}</span> : null}
          {view.command ? (
            <span className="wb-gen-summary__row-command" title={`命令 ${view.command}`}>
              <span className="wb-gen-summary__row-command-label">命令</span>
              <code>{view.command}</code>
            </span>
          ) : null}
        </span>
        {view.detail ? (
          <span
            className="wb-gen-summary__row-detail"
            data-missing={view.detailMissing || undefined}
          >
            {view.detailLabel ? (
              <span className="wb-gen-summary__row-label">{view.detailLabel}</span>
            ) : null}
            {view.detail}
          </span>
        ) : null}
      </span>
    </li>
  )
}

function CardGroup({
  entry,
  cards
}: {
  entry: InputSummaryEntry
  cards: readonly SessionCard[]
}): ReactElement {
  return (
    <section className="wb-gen-summary__group" data-kind={entry.key}>
      <div className="wb-gen-summary__group-head">
        <span aria-hidden="true" className="wb-gen-summary__group-icon" data-kind={entry.key}>
          <InputKindIcon kind={entry.key} />
        </span>
        <h3>{entry.label}</h3>
        <span className="wb-gen-summary__group-count">{entry.count} 项</span>
      </div>
      <ul>
        {cards
          .filter((card) => card.kind === entry.key)
          .map((card) => (
            <CardRow card={card} key={card.cardId} />
          ))}
      </ul>
    </section>
  )
}

function SummaryStateArt({ tone }: { tone: 'empty' | 'loading' | 'error' }): ReactElement {
  return (
    <span aria-hidden="true" className="wb-gen-summary__state-art" data-tone={tone}>
      <span className="wb-gen-summary__state-tile" data-kind="document">
        <InputKindIcon kind="document" />
      </span>
      <span className="wb-gen-summary__state-tile" data-kind="image">
        <InputKindIcon kind="image" />
      </span>
      <span className="wb-gen-summary__state-tile" data-kind="audio">
        <InputKindIcon kind="audio" />
      </span>
    </span>
  )
}

function SummaryState({
  tone,
  title,
  body,
  action
}: {
  tone: 'empty' | 'loading' | 'error'
  title: string
  body: string
  action?: ReactElement | null
}): ReactElement {
  return (
    <div
      aria-live={tone === 'loading' ? 'polite' : undefined}
      className="wb-gen-summary__state"
      data-layout={tone === 'empty' ? 'empty' : 'inline'}
      data-tone={tone}
      role={tone === 'loading' ? 'status' : tone === 'error' ? 'alert' : undefined}
    >
      <SummaryStateArt tone={tone} />
      <div className="wb-gen-summary__state-copy">
        <strong>{title}</strong>
        <p>{body}</p>
        {action}
      </div>
      {tone === 'error' ? (
        <CircleAlert aria-hidden="true" className="wb-gen-summary__state-icon" />
      ) : null}
    </div>
  )
}

function SummaryDonut({
  entries,
  scopeLabel
}: {
  entries: readonly InputSummaryEntry[]
  scopeLabel: string
}): ReactElement {
  const rawId = useId()
  const total = entries.reduce((sum, entry) => sum + entry.count, 0)
  const visible = entries.filter((entry) => entry.count > 0)
  const lengths = visible.map((entry) =>
    total > 0 ? (entry.count / total) * DONUT_CIRCUMFERENCE : 0
  )
  const segments = visible.map((entry, index) => ({
    ...entry,
    length: Math.max(lengths[index] - 3, 1),
    offset: -lengths.slice(0, index).reduce((sum, value) => sum + value, 0),
    color: colorAt(entry, entries.indexOf(entry))
  }))

  return (
    <div className="wb-gen-chart">
      <div className="wb-gen-chart__ring">
        <svg aria-label={`${scopeLabel}共 ${total} 项`} role="img" viewBox="0 0 160 160">
          <circle
            className="wb-gen-chart__track"
            cx="80"
            cy="80"
            fill="none"
            r={DONUT_RADIUS}
            strokeWidth="16"
          />
          <g key={rawId} transform="rotate(-90 80 80)">
            {segments.map((segment) => (
              <circle
                className="wb-gen-chart__segment"
                cx="80"
                cy="80"
                fill="none"
                key={segment.key}
                r={DONUT_RADIUS}
                strokeDasharray={`${segment.length} ${DONUT_CIRCUMFERENCE - segment.length}`}
                strokeDashoffset={segment.offset}
                strokeWidth="16"
                style={{ stroke: segment.color }}
              />
            ))}
          </g>
        </svg>
        <div className="wb-gen-chart__center">
          <strong>
            <CountUp value={total} />
          </strong>
          <span>{total > 0 ? '输入项' : '暂无输入'}</span>
        </div>
      </div>
      <ul className="wb-gen-chart__legend">
        {entries.map((entry, index) => (
          <li
            className="wb-gen-chart__legend-item"
            data-empty={entry.count === 0 || undefined}
            key={entry.key}
          >
            <span
              aria-hidden="true"
              className="wb-gen-chart__swatch"
              style={{ background: colorAt(entry, index) }}
            >
              <InputKindIcon kind={entry.key} />
            </span>
            <span className="wb-gen-chart__label">{entry.label}</span>
            <span className="wb-gen-chart__count">
              <CountUp value={entry.count} />
            </span>
          </li>
        ))}
      </ul>
    </div>
  )
}

function missingPurposeCountOf(cards: readonly SessionCard[]): number {
  let missing = 0
  for (const card of cards) {
    if (card.kind !== 'image' && card.kind !== 'audio' && card.kind !== 'video') continue
    if (card.summary.trim() === '') missing += 1
  }
  return missing
}

function CardGroups({
  cards,
  onReturnToCanvas
}: {
  cards: readonly SessionCard[]
  onReturnToCanvas?: () => void
}): ReactElement {
  const entries = countCanvasCards(cards).filter((entry) => entry.count > 0)
  const inputs = entries.filter((entry) => !isFieldKind(entry.key))
  const fields = entries.filter((entry) => isFieldKind(entry.key))
  const fieldTotal = fields.reduce((sum, entry) => sum + entry.count, 0)

  return (
    <div className="wb-gen-summary__groups">
      {inputs.length === 0 ? (
        <SummaryState
          action={
            cards.length === 0 && onReturnToCanvas ? (
              <button
                className="wb-gen-summary__state-action"
                onClick={onReturnToCanvas}
                type="button"
              >
                回到画布添加输入
                <ArrowRight aria-hidden="true" />
              </button>
            ) : null
          }
          body={
            cards.length === 0
              ? '文档、素材和提示词会显示在这里。'
              : '动画和特效字段不计入生成输入。'
          }
          title={cards.length === 0 ? '画布上还没有卡片' : '画布上还没有可纳入生成的输入'}
          tone="empty"
        />
      ) : (
        inputs.map((entry) => <CardGroup cards={cards} entry={entry} key={entry.key} />)
      )}

      {fields.length > 0 ? (
        <section aria-label="字段绑定" className="wb-gen-summary__fields">
          <div className="wb-gen-summary__fields-head">
            <h3>字段绑定</h3>
            <span>{fieldTotal} 项 · 未用于本轮生成</span>
          </div>
          <p className="wb-gen-summary__fields-note">
            字段绑定只随画布保存，不参与生成，不计入输入统计。
          </p>
          {fields.map((entry) => (
            <CardGroup cards={cards} entry={entry} key={entry.key} />
          ))}
        </section>
      ) : null}
    </div>
  )
}

function SnapshotDetails({
  entries
}: {
  entries: readonly InputSummaryEntry[]
}): ReactElement | null {
  const groups = entries.filter((entry) => (entry.details?.length ?? 0) > 0)
  if (groups.length === 0) return null
  return (
    <div className="wb-gen-summary__details">
      {groups.map((entry) => (
        <div className="wb-gen-summary__details-group" key={entry.key}>
          <h4>
            <span aria-hidden="true" className="wb-gen-summary__details-icon">
              <InputKindIcon kind={entry.key} />
            </span>
            {entry.label}
          </h4>
          <ul className="wb-gen-summary__details-list">
            {entry.details?.map((detail, index) => (
              <li key={`${entry.key}-${index}`}>{detail}</li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  )
}

function SnapshotNotice({
  field,
  entries
}: {
  field: InputSummaryEntry | null
  entries: readonly InputSummaryEntry[]
}): ReactElement {
  return (
    <section className="wb-gen-summary__snapshot">
      <div className="wb-gen-summary__snapshot-head">
        <h3>本轮输入已固定</h3>
        <span>
          <LockKeyhole aria-hidden="true" />
          只读 · 不再重新读取
        </span>
      </div>
      {field && field.count > 0 ? (
        <p className="wb-gen-summary__snapshot-field">
          <span>{field.label}</span>
          <strong>{field.count} 项</strong>
          <span className="wb-gen-summary__snapshot-note">字段绑定，未用于本轮生成</span>
        </p>
      ) : null}
      <SnapshotDetails entries={entries} />
    </section>
  )
}

function MissingPurposeNotice({
  count,
  onReturnToCanvas
}: {
  count: number
  onReturnToCanvas?: () => void
}): ReactElement {
  return (
    <section className="wb-gen-summary__missing" role="status">
      <span aria-hidden="true" className="wb-gen-summary__missing-icon">
        <CircleAlert />
      </span>
      <span className="wb-gen-summary__missing-copy">
        <strong>{count} 项素材还没写用途说明</strong>
        <span>用途说明会随素材一起送入生成。</span>
      </span>
      {onReturnToCanvas ? (
        <button className="wb-gen-summary__missing-action" onClick={onReturnToCanvas} type="button">
          回到画布补充
          <ArrowRight aria-hidden="true" />
        </button>
      ) : null}
    </section>
  )
}

export interface GenerationInputSummaryViewProps {
  status: SceneGenerationRenderStatusVO | null
  cards: readonly SessionCard[]
  loading?: boolean
  loadError?: string | null
  /** 当前画布是否有尚未保存的改动；只影响摘要上的真实保存状态标签。 */
  dirty?: boolean
  /** 读取失败时回到画布重新读取。 */
  onReload?: () => void
  /** 空态或补用途时回到画布；不伪造编辑动作。 */
  onReturnToCanvas?: () => void
}

export function GenerationInputSummaryView({
  status,
  cards,
  loading = false,
  loadError = null,
  dirty = false,
  onReload,
  onReturnToCanvas
}: GenerationInputSummaryViewProps): ReactElement {
  const started = status !== null

  if (!started && loading) {
    return (
      <div className="wb-gen-summary" data-motion="summary">
        <SummaryState
          body="画布、文档和素材读取完成后会显示在这里。"
          title="正在读取画布上的输入…"
          tone="loading"
        />
      </div>
    )
  }

  if (!started && loadError !== null && loadError !== '') {
    return (
      <div className="wb-gen-summary" data-motion="summary">
        <SummaryState
          action={
            onReload ? (
              <button className="wb-gen-summary__state-action" onClick={onReload} type="button">
                重新读取画布
              </button>
            ) : null
          }
          body={loadError}
          title="画布输入没有读取到"
          tone="error"
        />
      </div>
    )
  }

  const entries = started ? countStatusInputs(status.inputSummary) : countCanvasCards(cards)
  const field = started ? (entries.find((entry) => isFieldBindingKey(entry.key)) ?? null) : null
  const inputs = started
    ? entries.filter((entry) => !isFieldBindingKey(entry.key))
    : entries.filter((entry) => !isFieldKind(entry.key))
  const missingPurpose = started ? 0 : missingPurposeCountOf(cards)

  return (
    <div className="wb-gen-summary" data-motion="summary">
      <header className="wb-gen-summary__hero">
        <div className="wb-gen-summary__copy">
          <p className="wb-gen-summary__eyebrow">
            {started ? <LockKeyhole aria-hidden="true" /> : <Layers aria-hidden="true" />}
            {started ? '本轮快照' : '生成前可核对'}
            {started ? null : <span className="wb-gen-summary__readonly">只读</span>}
          </p>
          <h2>{started ? '启动时的编排快照' : '当前画布输入'}</h2>
          {started ? <p>快照已固定，不再随画布改动。</p> : null}
          {started ? null : (
            <div className="wb-gen-summary__state-row">
              <span
                className="wb-gen-summary__saved"
                data-tone={dirty ? 'dirty' : 'saved'}
                role="status"
              >
                {dirty ? <CircleAlert aria-hidden="true" /> : <Check aria-hidden="true" />}
                {dirty ? '有未保存改动' : '已保存编排'}
              </span>
            </div>
          )}
        </div>
        <SummaryDonut entries={inputs} scopeLabel={started ? '本轮输入' : '画布输入'} />
      </header>

      {started ? <SnapshotNotice entries={inputs} field={field} /> : null}
      {started ? null : (
        <>
          {missingPurpose > 0 ? (
            <MissingPurposeNotice count={missingPurpose} onReturnToCanvas={onReturnToCanvas} />
          ) : null}
          <CardGroups cards={cards} onReturnToCanvas={onReturnToCanvas} />
          <p className="wb-gen-summary__lock">
            <Check aria-hidden="true" />
            启动生成会先保存画布，再建立快照。
          </p>
        </>
      )}
    </div>
  )
}

export type GenerationInputSummaryCount = InputSummaryEntry & {
  unconsumed: boolean
}

function entriesOf(
  status: SceneGenerationRenderStatusVO | null,
  cards: readonly SessionCard[]
): readonly GenerationInputSummaryCount[] {
  if (status !== null) {
    return countStatusInputs(status.inputSummary).map((entry) => ({
      ...entry,
      unconsumed: isFieldBindingKey(entry.key)
    }))
  }
  return countCanvasCards(cards).map((entry) => ({
    ...entry,
    unconsumed: isFieldKind(entry.key)
  }))
}

function metaTextOf(entries: readonly InputSummaryEntry[], empty: string): string {
  const visible = entries.filter((entry) => entry.count > 0)
  if (visible.length === 0) return empty
  return visible.map((entry) => `${entry.label} ${entry.count}`).join(' · ')
}

export interface GenerationInputSummaryPopoverProps {
  entries: readonly GenerationInputSummaryCount[]
  onViewFullSummary?: () => void
}

export function GenerationInputSummaryPopover({
  entries,
  onViewFullSummary
}: GenerationInputSummaryPopoverProps): ReactElement {
  return (
    <div className="wb-gen-summary__popover-body">
      <ul className="wb-gen-summary__counts">
        {entries.map((entry) => (
          <li data-empty={entry.count === 0 || undefined} key={entry.key}>
            <span className="wb-gen-summary__counts-label">
              <span aria-hidden="true" className="wb-gen-summary__counts-icon">
                <InputKindIcon kind={entry.key} />
              </span>
              {entry.label}
            </span>
            {entry.unconsumed && entry.count > 0 ? (
              <span className="wb-gen-summary__counts-tag">未用于本轮生成</span>
            ) : null}
            <strong className="wb-gen-summary__counts-value">{entry.count}</strong>
          </li>
        ))}
      </ul>
      {onViewFullSummary ? (
        <button
          className="wb-gen-summary__popover-action"
          onClick={onViewFullSummary}
          type="button"
        >
          查看完整摘要
          <ArrowRight aria-hidden="true" />
        </button>
      ) : null}
    </div>
  )
}

export interface GenerationInputSummaryBarProps {
  status: SceneGenerationRenderStatusVO | null
  cards: readonly SessionCard[]
  open: boolean
  onOpenChange: (open: boolean) => void
  onOpenFullSummary?: () => void
}

export function GenerationInputSummaryBar({
  status,
  cards,
  open,
  onOpenChange,
  onOpenFullSummary
}: GenerationInputSummaryBarProps): ReactElement {
  const entries = entriesOf(status, cards)
  const inputs = entries.filter((entry) => !entry.unconsumed)
  const meta = status
    ? `本轮快照 · ${metaTextOf(inputs, '本轮快照没有可用的输入')}`
    : `当前画布 · ${metaTextOf(inputs, '当前画布还没有可用的输入')}`

  return (
    <div className="wb-gen-summary-bar">
      <Popover onOpenChange={onOpenChange} open={open}>
        <PopoverTrigger asChild>
          <button className="wb-gen-summary-bar__trigger" type="button">
            <span aria-hidden="true" className="wb-gen-summary-bar__icon">
              <Layers />
            </span>
            <span className="wb-gen-summary-bar__text">
              <strong>输入摘要</strong>
              <span>{meta}</span>
            </span>
            <svg
              aria-hidden="true"
              className="wb-gen-summary-bar__chevron"
              fill="none"
              viewBox="0 0 16 16"
            >
              <path
                d="m4 6 4 4 4-4"
                stroke="currentColor"
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth="1.6"
              />
            </svg>
          </button>
        </PopoverTrigger>
        <PopoverContent
          align="end"
          aria-label="输入分类计数"
          className="wb-gen-summary__popover"
          side="top"
          sideOffset={8}
        >
          <GenerationInputSummaryPopover
            entries={entries}
            onViewFullSummary={
              onOpenFullSummary
                ? () => {
                    onOpenChange(false)
                    onOpenFullSummary()
                  }
                : undefined
            }
          />
        </PopoverContent>
      </Popover>
    </div>
  )
}
