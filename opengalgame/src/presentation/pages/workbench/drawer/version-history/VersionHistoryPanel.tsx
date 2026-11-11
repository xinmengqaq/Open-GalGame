import { clsx } from 'clsx'
import { ChevronDown, RefreshCw, Sparkles, X } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react'
import { toast } from 'sonner'

import type { ClearVersionHistoryDTO } from '@application/project-versioning/dto/ProjectVersioningDTO'
import type { VersionHistoryEntryVO } from '@application/project-versioning/vo/VersionHistoryVO'
import type { ProjectVersioningClient } from '@interfaces/project-versioning/client/ProjectVersioningClient'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger
} from '@presentation/components/ui/collapsible'
import type { SessionSnapshot } from '@presentation/features/workbench-session/workbenchSession.types'
import { ClearIcon, HistoryIcon, UndoIcon } from '../../WorkbenchIcons'
import { CountUp } from '../CountUp'
import { TicksGlyph, TimelineGlyph } from '../drawerIcons'
import type { WorkbenchDrawerBusy } from '../workbenchDrawer.types'
import { ClearConfirmDialog, UndoConfirmDialog } from './VersionHistoryDialogs'
import {
  contentSourceLabel,
  formatHistoryClock,
  formatHistoryRange,
  formatHistoryTime,
  groupHistoryByDay,
  historyFeedback,
  historyFilters,
  saveModeLabel,
  sourceModuleLabel,
  type HistoryFilter,
  type HistoryListItem
} from './versionHistoryPresentation'
import { useVersionHistory } from './useVersionHistory'
import { useVersionHistoryMotion } from './useVersionHistoryMotion'
import './works-states.css'
import './works.css'

interface VersionHistoryPanelProps {
  projectId: string
  /** 统一标签内的工程名；旧抽屉不传时仍保留自身标题，不依赖壳层 title-block。 */
  projectName?: string
  client: ProjectVersioningClient
  writeBlockedReason: string | null
  hasUnsavedEdits: boolean
  captureDraft: () => Promise<SessionSnapshot | null>
  onUndoCommitted: (draft: SessionSnapshot | null) => Promise<void>
  onBusyChange?: (busy: WorkbenchDrawerBusy) => void
  onOpenAi?: () => void
}

type ConfirmState =
  | { kind: 'undo'; entry: VersionHistoryEntryVO }
  | { kind: 'clearEntry'; entry: VersionHistoryEntryVO }
  | { kind: 'clearCategory'; entry: VersionHistoryEntryVO }

const RELOAD_ERROR_TOAST = 'works-reload-error'
const MORE_ERROR_TOAST = 'works-more-error'

function TimelineNode({ kind }: { kind: 'manual' | 'auto' | 'reverted' }): ReactElement {
  if (kind === 'auto') {
    return (
      <span className="works-node works-node--auto" aria-hidden="true">
        <TicksGlyph />
      </span>
    )
  }

  return (
    <span className={clsx('works-node', `works-node--${kind}`)} aria-hidden="true">
      <svg viewBox="0 0 28 28">
        <circle className="works-node__glow" cx="14" cy="14" r="12" />
        <circle className="works-node__ring" cx="14" cy="14" r="7" />
        <circle className="works-node__core" cx="14" cy="14" r="3.1" />
      </svg>
    </span>
  )
}

function WorksRow({
  entry,
  selected,
  onSelect
}: {
  entry: VersionHistoryEntryVO
  selected: boolean
  onSelect: () => void
}): ReactElement {
  const reverted = entry.state === '已回退'
  return (
    <button
      aria-expanded={selected}
      aria-pressed={selected}
      className="works-row"
      data-reverted={reverted}
      data-selected={selected}
      data-works-motion="row"
      onClick={onSelect}
      type="button"
    >
      <span className="works-row__time">
        <time dateTime={entry.createdAt}>{formatHistoryClock(entry.createdAt)}</time>
      </span>
      <TimelineNode kind={reverted ? 'reverted' : 'manual'} />
      <span className="works-row__main">
        <span className="works-row__title-line">
          <span className="works-row__title">{entry.title}</span>
          {entry.contentSource === 'ai' ? (
            <span className="works-badge works-badge--ai">{historyFeedback.ai}</span>
          ) : null}
          {reverted ? <span className="works-reverted">{historyFeedback.reverted}</span> : null}
        </span>
        {entry.summary ? <span className="works-row__summary">{entry.summary}</span> : null}
        <span className="works-row__meta">
          <span>{sourceModuleLabel(entry.sourceModule)}</span>
          <span>{saveModeLabel(entry.saveMode)}</span>
          <span>{contentSourceLabel(entry.contentSource)}</span>
        </span>
      </span>
      <ChevronDown className="works-row__chevron" />
    </button>
  )
}

function SystemGroup({
  item,
  expanded,
  selectedId,
  onToggle,
  onSelect
}: {
  item: Extract<HistoryListItem, { kind: 'systemGroup' }>
  expanded: boolean
  selectedId: string | null
  onToggle: () => void
  onSelect: (historyId: string) => void
}): ReactElement {
  const newest = item.entries[0]
  const oldest = item.entries.at(-1) ?? newest
  return (
    <Collapsible onOpenChange={onToggle} open={expanded}>
      <CollapsibleTrigger asChild>
        <button className="works-group" data-works-motion="row" type="button">
          <span className="works-group__time">{formatHistoryClock(oldest.createdAt)}</span>
          <TimelineNode kind="auto" />
          <span className="works-row__main">
            <span className="works-group__title">
              {historyFeedback.system}
              <span className="works-group__count">{item.entries.length} 条</span>
            </span>
            <span className="works-row__summary">
              连续编排快照 · {formatHistoryRange(item.entries)}
            </span>
            <span className="works-row__meta">
              <span>{sourceModuleLabel(newest.sourceModule)}</span>
              <span>{expanded ? '收起单条记录' : '展开查看单条'}</span>
            </span>
          </span>
          <ChevronDown className="works-group__chevron" />
        </button>
      </CollapsibleTrigger>
      <CollapsibleContent className="works-group__content">
        {item.entries.map((entry) => (
          <button
            aria-pressed={selectedId === entry.historyId}
            className="works-subrow"
            data-selected={selectedId === entry.historyId}
            data-works-motion="subrow"
            key={entry.historyId}
            onClick={() => onSelect(entry.historyId)}
            type="button"
          >
            <span className="works-subrow__time">
              <time dateTime={entry.createdAt}>{formatHistoryClock(entry.createdAt)}</time>
            </span>
            <span className="works-subrow__main">
              <span className="works-subrow__title">{entry.title}</span>
              <span className="works-subrow__meta">
                {sourceModuleLabel(entry.sourceModule)} · {contentSourceLabel(entry.contentSource)}
                {entry.state === '已回退' ? ` · ${historyFeedback.reverted}` : ''}
              </span>
            </span>
            <ChevronDown className="works-subrow__chevron" />
          </button>
        ))}
      </CollapsibleContent>
    </Collapsible>
  )
}

function WorksDetail({
  entry,
  canWrite,
  blockedReason,
  onUndo,
  onClearEntry,
  onClearCategory,
  onClose
}: {
  entry: VersionHistoryEntryVO
  canWrite: boolean
  blockedReason: string | null
  onUndo: () => void
  onClearEntry: () => void
  onClearCategory: () => void
  onClose: () => void
}): ReactElement {
  const reverted = entry.state === '已回退'
  const hasAction = entry.canUndo || entry.canClear
  return (
    <section
      aria-label="记录详情"
      className="works-detail"
      data-works-motion="detail"
      data-reverted={reverted}
    >
      <div className="works-detail__head">
        <div className="works-detail__title-block">
          <p className="works-detail__eyebrow">记录详情</p>
          <h3 className="works-detail__title">{entry.title}</h3>
          <p className="works-detail__meta">
            <time dateTime={entry.createdAt}>{formatHistoryTime(entry.createdAt)}</time>
            <span aria-hidden="true">·</span>
            <span>{contentSourceLabel(entry.contentSource)}</span>
          </p>
        </div>
        <div className="works-detail__badges">
          {entry.contentSource === 'ai' ? (
            <span className="works-badge works-badge--ai">{historyFeedback.ai}</span>
          ) : null}
        </div>
        <button aria-label="收起详情" className="works-icon-button" onClick={onClose} type="button">
          <X />
        </button>
      </div>

      <div className="works-detail__scroll" tabIndex={0}>
        <p className="works-detail__summary">{entry.summary || '这条记录没有摘要。'}</p>
        <dl className="works-detail__grid">
          <div className="works-detail__field">
            <dt>保存方式</dt>
            <dd>{saveModeLabel(entry.saveMode)}</dd>
          </div>
          <div className="works-detail__field">
            <dt>内容来源</dt>
            <dd>{contentSourceLabel(entry.contentSource)}</dd>
          </div>
          <div className="works-detail__field">
            <dt>来源模块</dt>
            <dd>{sourceModuleLabel(entry.sourceModule)}</dd>
          </div>
          <div className="works-detail__field">
            <dt>状态</dt>
            <dd>{entry.state}</dd>
          </div>
        </dl>
        {!entry.canUndo && !reverted ? (
          <p className="works-detail__note">{historyFeedback.cannotUndo}</p>
        ) : null}
        {hasAction && blockedReason ? (
          <p className="works-detail__blocked" role="status">
            {blockedReason}
          </p>
        ) : null}
        {entry.canClear ? (
          <p className="works-detail__note">清理只影响历史记录，不改变作品内容。</p>
        ) : null}
      </div>

      {hasAction ? (
        <div className="works-detail__actions">
          {entry.canUndo && !reverted ? (
            <button
              className="works-primary"
              disabled={!canWrite}
              onClick={onUndo}
              title={blockedReason ?? undefined}
              type="button"
            >
              <UndoIcon />
              {historyFeedback.undo}
            </button>
          ) : null}
          {entry.canClear ? (
            <div className="works-detail__danger-actions">
              <button
                className="works-danger"
                disabled={!canWrite}
                onClick={onClearEntry}
                title={blockedReason ?? undefined}
                type="button"
              >
                <ClearIcon />
                {historyFeedback.clearEntry}
              </button>
              <button
                className="works-danger works-danger--quiet"
                disabled={!canWrite}
                onClick={onClearCategory}
                title={blockedReason ?? undefined}
                type="button"
              >
                <ClearIcon />
                {entry.saveMode === 'manual'
                  ? historyFeedback.clearManualBefore
                  : historyFeedback.clearSystemBefore}
              </button>
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  )
}

function WorksSkeleton(): ReactElement {
  return (
    <div aria-label={historyFeedback.loading} className="works-skeleton" role="status">
      <div className="works-skeleton__date works-shimmer" />
      {[0, 1, 2, 3, 4].map((index) => (
        <div className="works-skeleton__row" key={index}>
          <div className="works-skeleton__time works-shimmer" />
          <div className="works-skeleton__node works-shimmer" />
          <div className="works-skeleton__main">
            <div className="works-skeleton__title works-shimmer" />
            <div
              className="works-skeleton__line works-shimmer"
              style={{ width: `${86 - index * 7}%` }}
            />
            <div className="works-skeleton__meta works-shimmer" />
          </div>
        </div>
      ))}
    </div>
  )
}

function WorksEmpty({ onOpenAi }: { onOpenAi?: () => void }): ReactElement {
  return (
    <div className="works-empty">
      <span className="works-empty__ghost" aria-hidden="true" />
      <div className="works-empty__node">
        <span aria-hidden="true" className="works-empty__mark">
          <TimelineGlyph />
        </span>
        <span className="works-empty__label">{historyFeedback.empty}</span>
      </div>
      <div className="works-empty__copy">
        <h3>第一次保存后，时间线会从这里开始。</h3>
        <p>
          手动保存会成为里程碑，连续的自动保存会折叠成计数分组。作品历史只读取已保存的记录，不展示候选或草稿。
        </p>
        {onOpenAi ? (
          <button className="works-secondary" onClick={onOpenAi} type="button">
            <Sparkles />
            回到当前生成
          </button>
        ) : null}
      </div>
    </div>
  )
}

/**
 * 工程级作品历史：读取、筛选、时间线、分组、详情和写操作确认。
 * 统计只表示当前已加载记录；撤销与清理仍由 useVersionHistory 和版本具名客户端执行。
 */
export function VersionHistoryPanel({
  projectId,
  projectName,
  client,
  writeBlockedReason,
  hasUnsavedEdits,
  captureDraft,
  onUndoCommitted,
  onBusyChange,
  onOpenAi
}: VersionHistoryPanelProps): ReactElement {
  const history = useVersionHistory({
    client,
    projectId,
    writeBlockedReason,
    captureDraft,
    onUndoCommitted
  })
  const [expandedGroups, setExpandedGroups] = useState<ReadonlySet<string>>(() => new Set())
  const [confirm, setConfirm] = useState<ConfirmState | null>(null)
  const root = useRef<HTMLDivElement>(null)
  const scroller = useRef<HTMLDivElement>(null)

  const sections = useMemo(() => groupHistoryByDay(history.entries), [history.entries])
  const stats = useMemo(() => {
    let manual = 0
    let system = 0
    let ai = 0
    let reverted = 0
    for (const entry of history.entries) {
      if (entry.saveMode === 'manual') manual += 1
      else system += 1
      if (entry.contentSource === 'ai') ai += 1
      if (entry.state === '已回退') reverted += 1
    }
    return { total: history.entries.length, manual, system, ai, reverted }
  }, [history.entries])

  const loading = history.status === 'loading'
  const countsUnknown = loading || history.status === 'failed'
  const expandedKey = [...expandedGroups].sort().join('|')

  useVersionHistoryMotion(root, {
    status: history.status,
    filter: history.filter,
    resetToken: history.resetToken,
    expandedKey,
    selectedId: history.selectedId
  })

  useEffect(() => {
    onBusyChange?.(history.busy)
  }, [history.busy, onBusyChange])

  useEffect(() => {
    scroller.current?.scrollTo({ top: 0 })
  }, [history.resetToken])

  /* 读取失败保留已加载记录，只把提示浮在布局之外；工具栏和分页仍提供重试入口。 */
  useEffect(() => {
    if (history.reloadError === null) {
      toast.dismiss(RELOAD_ERROR_TOAST)
      return
    }
    toast.error(history.reloadError.msg || historyFeedback.loadFailed, {
      id: RELOAD_ERROR_TOAST,
      description: '已保留当前记录，可在工具栏重新读取。',
      duration: 8000
    })
  }, [history.reloadError])

  useEffect(() => {
    if (history.moreError === null) {
      toast.dismiss(MORE_ERROR_TOAST)
      return
    }
    toast.error(history.moreError.msg || historyFeedback.moreFailed, {
      id: MORE_ERROR_TOAST,
      description: '已保留当前列表，可继续加载。',
      duration: 8000
    })
  }, [history.moreError])

  const filterCount = (value: HistoryFilter): number | null => {
    if (value === 'all') return history.filter === 'all' ? stats.total : null
    if (value === 'manual') {
      return history.filter === 'all' || history.filter === 'manual' ? stats.manual : null
    }
    return history.filter === 'all' || history.filter === 'system' ? stats.system : null
  }

  const sectionCount = (section: (typeof sections)[number]): string => {
    let manual = 0
    let system = 0
    for (const item of section.items) {
      if (item.kind === 'entry') {
        if (item.entry.saveMode === 'manual') manual += 1
        else system += 1
      } else {
        system += item.entries.length
      }
    }
    return [manual > 0 ? `${manual} 次手动保存` : null, system > 0 ? `${system} 次自动保存` : null]
      .filter(Boolean)
      .join(' · ')
  }

  const toggleGroup = useCallback((groupId: string) => {
    setExpandedGroups((current) => {
      const next = new Set(current)
      if (next.has(groupId)) next.delete(groupId)
      else next.add(groupId)
      return next
    })
  }, [])

  const selectEntry = useCallback(
    (historyId: string) => {
      history.selectEntry(history.selectedId === historyId ? null : historyId)
    },
    [history]
  )

  const openConfirm = useCallback(
    (next: ConfirmState) => {
      history.dismissActionFailure()
      setConfirm(next)
    },
    [history]
  )

  const closeConfirm = useCallback(() => {
    setConfirm(null)
    history.dismissActionFailure()
  }, [history])

  const confirmUndo = async (): Promise<void> => {
    if (confirm?.kind !== 'undo') return
    const done = await history.undo(confirm.entry)
    if (done) setConfirm(null)
  }

  const confirmClear = async (): Promise<void> => {
    if (!confirm || confirm.kind === 'undo') return
    const selection: ClearVersionHistoryDTO['selection'] =
      confirm.kind === 'clearEntry'
        ? { kind: 'entry', historyId: confirm.entry.historyId }
        : {
            kind: 'category',
            saveMode: confirm.entry.saveMode,
            throughHistoryId: confirm.entry.historyId
          }
    const cleared = await history.clear(selection)
    if (cleared !== null) setConfirm(null)
  }

  const loadMore = async (): Promise<void> => {
    const node = scroller.current
    const top = node?.scrollTop ?? 0
    await history.loadMore()
    window.requestAnimationFrame(() => {
      if (node) node.scrollTop = top
    })
  }

  const selectedEntry = history.selectedEntry

  return (
    <div className="works-panel" ref={root}>
      <div className="works-head">
        <div className="works-head__copy">
          {projectName ? <p className="wb-works__project">{projectName}</p> : null}
          <h2 className="works-head__title">作品历史</h2>
          <p className="works-head__note">工程级保存记录 · 仅统计已加载范围</p>
        </div>
        <span className="works-head__scope">
          {loading
            ? historyFeedback.loading
            : history.status === 'failed'
              ? '读取失败'
              : `${stats.total} 条已加载`}
        </span>
      </div>

      <dl aria-label="已加载记录统计" className="works-stats">
        <div className="works-stat">
          <dt>已加载</dt>
          <dd>{countsUnknown ? '—' : <CountUp value={stats.total} />}</dd>
        </div>
        <div className="works-stat">
          <dt>手动</dt>
          <dd>
            {countsUnknown || filterCount('manual') === null ? (
              '—'
            ) : (
              <CountUp value={stats.manual} />
            )}
          </dd>
        </div>
        <div className="works-stat">
          <dt>自动</dt>
          <dd>
            {countsUnknown || filterCount('system') === null ? (
              '—'
            ) : (
              <CountUp value={stats.system} />
            )}
          </dd>
        </div>
        <div className="works-stat">
          <dt>AI / 操作</dt>
          <dd>{countsUnknown ? '—' : <CountUp value={stats.ai} />}</dd>
        </div>
        <div className="works-stat works-stat--danger">
          <dt>已回退</dt>
          <dd>{countsUnknown ? '—' : <CountUp value={stats.reverted} />}</dd>
        </div>
      </dl>

      <div className="works-toolbar">
        <div aria-label="保存方式筛选" className="works-filter" role="group">
          <span
            aria-hidden="true"
            className="works-filter__indicator"
            style={{
              transform: `translateX(${
                Math.max(
                  0,
                  historyFilters.findIndex((item) => item.value === history.filter)
                ) * 100
              }%)`
            }}
          />
          {historyFilters.map((item) => {
            const count = countsUnknown ? null : filterCount(item.value)
            return (
              <button
                aria-pressed={history.filter === item.value}
                className="works-filter__item"
                disabled={history.busy !== null}
                key={item.value}
                onClick={() => history.setFilter(item.value)}
                title={count === null ? item.label : `${item.label} · 已加载 ${count} 条`}
                type="button"
              >
                {item.label}
                <span aria-hidden="true" className="works-filter__count">
                  {count === null ? '—' : count}
                </span>
              </button>
            )
          })}
        </div>
        <button
          className="works-action"
          disabled={history.busy !== null}
          onClick={history.reload}
          type="button"
        >
          <RefreshCw />
          刷新
        </button>
      </div>

      <div
        aria-busy={loading || history.loadingMore}
        aria-label="历史记录"
        className="works-scroll"
        ref={scroller}
        role="region"
        tabIndex={0}
      >
        {loading ? <WorksSkeleton /> : null}

        {history.status === 'failed' ? (
          <div className="works-state">
            <span className="works-state__mark" aria-hidden="true">
              <HistoryIcon />
            </span>
            <h3 className="works-state__title">{historyFeedback.loadFailed}</h3>
            <p className="works-state__detail">{history.error?.msg}</p>
            <button className="works-secondary" onClick={history.reload} type="button">
              {historyFeedback.retry}
            </button>
          </div>
        ) : null}

        {history.status === 'empty' ? <WorksEmpty onOpenAi={onOpenAi} /> : null}

        {!loading && history.status !== 'failed' && history.status !== 'empty' ? (
          <div className="works-timeline">
            <span aria-hidden="true" className="works-spine">
              <svg preserveAspectRatio="none" viewBox="0 0 2 1000">
                <defs>
                  <linearGradient
                    gradientUnits="userSpaceOnUse"
                    id="works-spine-gradient"
                    x1="0"
                    x2="0"
                    y1="0"
                    y2="1000"
                  >
                    <stop offset="0" stopColor="#8d67ab" stopOpacity=".55" />
                    <stop offset=".55" stopColor="#4a9c9b" stopOpacity=".32" />
                    <stop offset="1" stopColor="#4a9c9b" stopOpacity="0" />
                  </linearGradient>
                </defs>
                <line
                  className="works-spine__line"
                  stroke="url(#works-spine-gradient)"
                  strokeWidth="2"
                  x1="1"
                  x2="1"
                  y1="0"
                  y2="1000"
                />
              </svg>
            </span>

            {sections.map((section) => (
              <div className="works-day" key={section.key}>
                <div className="works-date" data-works-motion="date">
                  <span className="works-date__label">{section.label}</span>
                  <span className="works-date__line" aria-hidden="true" />
                  <span className="works-date__meta">{sectionCount(section)}</span>
                </div>
                {section.items.map((item) =>
                  item.kind === 'entry' ? (
                    <WorksRow
                      entry={item.entry}
                      key={item.entry.historyId}
                      onSelect={() => selectEntry(item.entry.historyId)}
                      selected={history.selectedId === item.entry.historyId}
                    />
                  ) : (
                    <SystemGroup
                      expanded={expandedGroups.has(item.groupId)}
                      item={item}
                      key={item.groupId}
                      onSelect={selectEntry}
                      onToggle={() => toggleGroup(item.groupId)}
                      selectedId={history.selectedId}
                    />
                  )
                )}
              </div>
            ))}

            <div className="works-pagination">
              <span className="works-loaded">
                {historyFeedback.loadedCount(history.entries.length)}
              </span>
              {history.nextCursor !== null ? (
                <button
                  className="works-more"
                  disabled={history.loadingMore}
                  onClick={() => void loadMore()}
                  type="button"
                >
                  {history.loadingMore
                    ? historyFeedback.loadingMore
                    : history.moreError
                      ? historyFeedback.retry
                      : historyFeedback.loadMore}
                </button>
              ) : null}
            </div>
          </div>
        ) : null}
      </div>

      {selectedEntry ? (
        <WorksDetail
          blockedReason={history.writeBlockedReason}
          canWrite={history.canWrite}
          entry={selectedEntry}
          onClearCategory={() => openConfirm({ kind: 'clearCategory', entry: selectedEntry })}
          onClearEntry={() => openConfirm({ kind: 'clearEntry', entry: selectedEntry })}
          onClose={() => history.selectEntry(null)}
          onUndo={() => openConfirm({ kind: 'undo', entry: selectedEntry })}
        />
      ) : null}

      <UndoConfirmDialog
        blockedReason={writeBlockedReason}
        busy={history.busy === 'undo'}
        entry={confirm?.kind === 'undo' ? confirm.entry : null}
        failure={history.actionFailure?.kind === 'undo' ? history.actionFailure : null}
        hasUnsavedEdits={hasUnsavedEdits}
        onCancel={closeConfirm}
        onConfirm={() => void confirmUndo()}
        onReloadHistory={() => {
          closeConfirm()
          history.reload()
        }}
        open={confirm?.kind === 'undo'}
      />

      <ClearConfirmDialog
        blockedReason={writeBlockedReason}
        busy={history.busy === 'clear'}
        entry={confirm && confirm.kind !== 'undo' ? confirm.entry : null}
        failure={history.actionFailure?.kind === 'clear' ? history.actionFailure : null}
        onCancel={closeConfirm}
        onConfirm={() => void confirmClear()}
        open={confirm?.kind === 'clearEntry' || confirm?.kind === 'clearCategory'}
        selection={
          confirm?.kind === 'clearEntry'
            ? { kind: 'entry', historyId: confirm.entry.historyId }
            : confirm?.kind === 'clearCategory'
              ? {
                  kind: 'category',
                  saveMode: confirm.entry.saveMode,
                  throughHistoryId: confirm.entry.historyId
                }
              : null
        }
      />
    </div>
  )
}
