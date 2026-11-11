import { ArrowRight, Check, CircleAlert, Layers, LockKeyhole } from 'lucide-react'
import { useId, type ReactElement } from 'react'

import type { SceneGenerationRenderStatusVO } from '@application/scene-generation/vo/SceneGenerationRenderVO'
import { Popover, PopoverContent, PopoverTrigger } from '@presentation/components/ui/popover'
import type { SessionCard } from '@presentation/features/workbench-session/workbenchSession.types'
import { CountUp } from '../CountUp'
import {
  countCanvasCards,
  countStatusInputs,
  type InputSummaryEntry
} from './generationPresentation'

/* 既有甜甜圈的七级分类色，只引用 tokens.css 里的调色板，不新增主题变量。 */
const SEGMENT_COLORS = [
  'var(--type-document)',
  'var(--type-image)',
  'var(--type-audio)',
  'var(--type-video)',
  'var(--purple-deep)',
  'var(--teal)',
  'var(--error)'
] as const
const DONUT_RADIUS = 62
const DONUT_CIRCUMFERENCE = 2 * Math.PI * DONUT_RADIUS

/** 动画、特效是字段卡片，不在本轮生成的已读输入里。 */
function isFieldKind(key: string): boolean {
  return key === 'animation' || key === 'effect'
}

/** 启动后的快照把动画、特效合并成一个字段绑定计数。 */
function isFieldBindingKey(key: string): boolean {
  return key === 'fieldBindingCount'
}

function colorAt(index: number): string {
  return SEGMENT_COLORS[index % SEGMENT_COLORS.length] ?? SEGMENT_COLORS[0]
}

function excerpt(text: string, max: number): string {
  const trimmed = text.trim()
  return trimmed.length > max ? `${trimmed.slice(0, max).trimEnd()}…` : trimmed
}

type CardRowView = {
  title: string
  detailLabel: '用途' | '正文' | null
  detail: string | null
  detailMissing: boolean
  command: string | null
}

/** 按真实卡片字段取标题、用途说明和字段卡片的命令引用，不从用途角色推导文案。 */
function cardRowViewOf(card: SessionCard): CardRowView {
  if (card.kind === 'prompt') {
    const body = card.body.trim()
    if (body === '') {
      return {
        title: '还没有写提示词',
        detailLabel: null,
        detail: null,
        detailMissing: false,
        command: null
      }
    }
    const firstLine = body.split(/\r?\n/).find((line) => line.trim().length > 0) ?? body
    const rest = body.slice(body.indexOf(firstLine) + firstLine.length).trim()
    // 标题已经展示首行；正文从首行之后接续，避免长提示词首行重复两遍。
    const afterTitle = firstLine.length > 40 ? firstLine.slice(40) : ''
    const continuation = [afterTitle, rest].filter((part) => part !== '').join('\n')
    return {
      title: excerpt(firstLine, 40),
      detailLabel: continuation === '' ? null : '正文',
      detail:
        continuation === ''
          ? null
          : `${firstLine.length > 40 ? '…' : ''}${excerpt(continuation, 200)}`,
      detailMissing: false,
      command: null
    }
  }
  if (card.kind === 'animation' || card.kind === 'effect') {
    const preset = card.webgalPreset
    if (preset === null) {
      return {
        title: '未选择预设',
        detailLabel: null,
        detail: '这张字段卡片还没有绑定命令。',
        detailMissing: true,
        command: null
      }
    }
    return {
      title: preset.name,
      detailLabel: null,
      detail: null,
      detailMissing: false,
      command: preset.command
    }
  }
  const summary = card.summary.trim()
  return {
    title: card.title,
    detailLabel: '用途',
    detail: summary === '' ? '未填写用途说明' : excerpt(summary, 200),
    detailMissing: summary === '',
    command: null
  }
}

function CardRow({ card }: { card: SessionCard }): ReactElement {
  const view = cardRowViewOf(card)
  return (
    <li className="wb-gen-summary__row">
      <span className="wb-gen-summary__row-title" title={view.title}>
        {view.title}
      </span>
      {view.detail ? (
        <span className="wb-gen-summary__row-detail" data-missing={view.detailMissing || undefined}>
          {view.detailLabel ? (
            <span className="wb-gen-summary__row-label">{view.detailLabel}</span>
          ) : null}
          {view.detail}
        </span>
      ) : null}
      {view.command ? (
        <span className="wb-gen-summary__row-command" title={`命令 ${view.command}`}>
          <span className="wb-gen-summary__row-command-label">命令</span>
          <code>{view.command}</code>
        </span>
      ) : null}
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
    <section className="wb-gen-summary__group">
      <div className="wb-gen-summary__group-head">
        <h3>{entry.label}</h3>
        <span>{entry.count} 项</span>
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

function SummaryState({
  tone,
  title,
  body
}: {
  tone: 'empty' | 'loading' | 'error'
  title: string
  body: string
}): ReactElement {
  return (
    <div
      aria-live={tone === 'loading' ? 'polite' : undefined}
      className="wb-gen-summary__state"
      data-tone={tone}
      role={tone === 'loading' ? 'status' : tone === 'error' ? 'alert' : undefined}
    >
      <span aria-hidden="true" className="wb-gen-summary__state-art">
        <span />
        <span />
        <span />
      </span>
      <div className="wb-gen-summary__state-copy">
        <strong>{title}</strong>
        <p>{body}</p>
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
    offset: -lengths.slice(0, index).reduce((sum, value) => sum + value, 0)
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
            {segments.map((segment, index) => {
              const color = colorAt(index)
              return (
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
                  style={{ stroke: color }}
                />
              )
            })}
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
          <li className="wb-gen-chart__legend-item" key={entry.key}>
            <span
              aria-hidden="true"
              className="wb-gen-chart__swatch"
              style={{ background: colorAt(index) }}
            />
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

/** 启动前的真实画布卡片：分类只展示已读输入，字段绑定单独说明未用于本轮生成。 */
function CardGroups({ cards }: { cards: readonly SessionCard[] }): ReactElement {
  const entries = countCanvasCards(cards).filter((entry) => entry.count > 0)
  const inputs = entries.filter((entry) => !isFieldKind(entry.key))
  const fields = entries.filter((entry) => isFieldKind(entry.key))
  const fieldTotal = fields.reduce((sum, entry) => sum + entry.count, 0)

  return (
    <div className="wb-gen-summary__groups">
      {inputs.length === 0 ? (
        <SummaryState
          body={
            cards.length === 0
              ? '先在场景画布摆好文档、素材和提示词，再开始生成。'
              : '先补充文档、素材或提示词；动画和特效字段不能替代这些输入。'
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
            这些字段只随画布保存，当前生成不会读取，因此不计入上面的输入统计。
          </p>
          {fields.map((entry) => (
            <CardGroup cards={cards} entry={entry} key={entry.key} />
          ))}
        </section>
      ) : null}
    </div>
  )
}

/**
 * 本轮快照的安全明细：只展示后端已给的标题、名称和范围，
 * 不展开正文、路径或内部身份；没有明细时不占位。
 */
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
          <h4>{entry.label}</h4>
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

/** 启动后只读本轮快照：计数由甜甜圈图例承担，这里保留固定说明、字段绑定和明细。 */
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
        <span>只读 · 不再重新读取</span>
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

export interface GenerationInputSummaryViewProps {
  status: SceneGenerationRenderStatusVO | null
  cards: readonly SessionCard[]
  /** 画布输入仍在读取；有快照时以快照为准。 */
  loading?: boolean
  /** 画布输入读取失败的安全文案；不显示路径或内部错误。 */
  loadError?: string | null
}

/** 输入摘要独立视图：启动前按真实卡片核对，启动后只读本轮快照计数。 */
export function GenerationInputSummaryView({
  status,
  cards,
  loading = false,
  loadError = null
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
        <SummaryState body={loadError} title="画布输入没有读取到" tone="error" />
      </div>
    )
  }

  const entries = started ? countStatusInputs(status.inputSummary) : countCanvasCards(cards)
  const field = started ? (entries.find((entry) => isFieldBindingKey(entry.key)) ?? null) : null
  const inputs = started
    ? entries.filter((entry) => !isFieldBindingKey(entry.key))
    : entries.filter((entry) => !isFieldKind(entry.key))

  return (
    <div className="wb-gen-summary" data-motion="summary">
      <header className="wb-gen-summary__hero">
        <div className="wb-gen-summary__copy">
          <p className="wb-gen-summary__eyebrow">
            {started ? <LockKeyhole aria-hidden="true" /> : <Layers aria-hidden="true" />}
            {started ? '本轮快照' : '生成前可核对'}
            {started ? null : <span className="wb-gen-summary__readonly">只读</span>}
          </p>
          <h2>{started ? '这一轮只读取启动时的编排快照。' : '先看清材料，再让 AI 开始写。'}</h2>
          <p>
            {started
              ? '切换标签、关闭抽屉或重新打开都不会重新读取或替换。'
              : '生成只读取当前场景已保存的编排。先核对文档、素材和提示词的用途说明，再开始生成。'}
          </p>
        </div>
        <SummaryDonut entries={inputs} scopeLabel={started ? '本轮输入' : '画布输入'} />
      </header>

      {started ? <SnapshotNotice entries={inputs} field={field} /> : <CardGroups cards={cards} />}

      {started ? null : (
        <p className="wb-gen-summary__lock">
          <Check aria-hidden="true" />
          启动生成会先保存画布，再用保存后的编排建立快照。
        </p>
      )}
    </div>
  )
}

export type GenerationInputSummaryCount = InputSummaryEntry & {
  /** 该分类只作字段绑定，不进入本轮生成。 */
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
  /** 提供时才显示“查看完整摘要”；旧调用没有完整视图可切，不造假动作。 */
  onViewFullSummary?: () => void
}

/** 轻量浮层只放分类计数和“查看完整摘要”，不重复渲染分组列表。 */
export function GenerationInputSummaryPopover({
  entries,
  onViewFullSummary
}: GenerationInputSummaryPopoverProps): ReactElement {
  return (
    <div className="wb-gen-summary__popover-body">
      <ul className="wb-gen-summary__counts">
        {entries.map((entry) => (
          <li key={entry.key}>
            <span className="wb-gen-summary__counts-label">{entry.label}</span>
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
  /** P4-2b 切到输入摘要标签；不传时浮层只显示计数。 */
  onOpenFullSummary?: () => void
}

/** 对话流底部的单行摘要入口：轻量浮层放分类计数，不再原位展开分组。 */
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
