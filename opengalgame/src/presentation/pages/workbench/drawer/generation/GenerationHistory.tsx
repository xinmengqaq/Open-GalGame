import {
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  Clock3,
  History,
  LockKeyhole,
  RefreshCw
} from 'lucide-react'
import { useEffect, useRef, useState, type ReactElement, type RefObject } from 'react'
import { toast } from 'sonner'

import type {
  SceneGenerationHistorySummaryVO,
  SceneGenerationRenderStatusVO
} from '@application/scene-generation/vo/SceneGenerationRenderVO'
import type { SceneGenerationClient } from '@interfaces/scene-generation/client/SceneGenerationClient'
import {
  activeHistoryRowViewOf,
  historyDetailViewOf,
  historyLegacyLabel,
  historyRowViewOf,
  type HistoryBoundaryTone
} from './generationHistoryPresentation'
import { useGenerationHistory } from './useGenerationHistory'
import './generationHistory.css'

interface GenerationHistoryProps {
  client: SceneGenerationClient
  projectId: string
  sceneId: string
  /** 当前操作进入终态或重新打开子标签时变化，用于重新读取第一页。 */
  refreshKey?: string
  /** 只读运行状态：在列表顶部显示进行中行，不写成历史记录。 */
  activeStatus?: SceneGenerationRenderStatusVO | null
  /** 进行中行是否显示取消入口；由调用方按现有状态动作决定。 */
  canCancel?: boolean
  cancelBusy?: boolean
  onCancel?: () => void
  /** 切到抽屉的当前运行视图。 */
  onOpenRun?: () => void
}

function HistoryStatusBadge({
  label,
  tone
}: {
  label: string
  tone: HistoryBoundaryTone
}): ReactElement {
  return (
    <span className="wb-hist__badge" data-tone={tone}>
      {label}
    </span>
  )
}

function HistorySkeleton(): ReactElement {
  return (
    <div aria-label="正在读取 AI 历史" className="wb-hist__skeleton" role="status">
      {[0, 1, 2, 3].map((row) => (
        <div className="wb-hist__skeleton-row" key={row}>
          <span className="wb-hist__shimmer wb-hist__skeleton-node" />
          <span className="wb-hist__shimmer wb-hist__skeleton-time" />
          <span className="wb-hist__skeleton-main">
            <span className="wb-hist__shimmer wb-hist__skeleton-badge" />
            <span className="wb-hist__shimmer wb-hist__skeleton-line" />
          </span>
        </div>
      ))}
    </div>
  )
}

function HistoryEmpty(): ReactElement {
  return (
    <div className="wb-hist__state wb-hist__state--empty">
      <svg aria-hidden="true" className="wb-hist__empty-art" viewBox="0 0 220 96">
        <line className="wb-hist__empty-spine" x1="36" x2="36" y1="8" y2="88" />
        <circle className="wb-hist__empty-node" cx="36" cy="22" r="7" />
        <circle className="wb-hist__empty-dot" cx="36" cy="56" r="4" />
        <rect className="wb-hist__empty-bar" height="8" rx="4" width="122" x="66" y="14" />
        <rect className="wb-hist__empty-bar" height="7" rx="3.5" width="88" x="66" y="34" />
        <rect className="wb-hist__empty-bar" height="8" rx="4" width="106" x="66" y="52" />
        <rect className="wb-hist__empty-bar" height="7" rx="3.5" width="64" x="66" y="72" />
      </svg>
      <h3>还没有 AI 历史记录</h3>
      <p>
        这个场景还没有产生可记录的生成操作。开始生成后，每次开始、等待决定、审阅、暂停和提交都会留在这里。
      </p>
    </div>
  )
}

export function HistoryDetail({
  backRef,
  onBack,
  record
}: {
  backRef: RefObject<HTMLButtonElement | null>
  onBack: () => void
  record: SceneGenerationHistorySummaryVO
}): ReactElement {
  const detail = historyDetailViewOf(record)
  return (
    <div className="wb-hist__detail wb-hist-page">
      <div className="wb-hist__detail-bar">
        <button className="wb-hist__back" onClick={onBack} ref={backRef} type="button">
          <ChevronLeft aria-hidden="true" />
          返回列表
        </button>
        <span className="wb-hist__readonly">
          <LockKeyhole aria-hidden="true" />
          只读记录
        </span>
      </div>
      <div
        aria-label="AI 历史记录详情"
        className="wb-hist__detail-scroll"
        role="region"
        tabIndex={0}
      >
        <div className="wb-hist__detail-body">
          <span aria-hidden="true" className="wb-hist__detail-node" />
          <p className="wb-hist__detail-kicker">
            <Clock3 aria-hidden="true" />
            {detail.clock}
          </p>
          <h2 className="wb-hist__detail-title">{detail.summary}</h2>
          <div className="wb-hist__detail-badges">
            <HistoryStatusBadge label={detail.boundary} tone={detail.tone} />
            {detail.legacy ? <span className="wb-hist__legacy">{historyLegacyLabel}</span> : null}
          </div>
          <dl className="wb-hist__meta">
            <div>
              <dt>记录时间</dt>
              <dd>{detail.time}</dd>
            </div>
            <div>
              <dt>操作边界</dt>
              <dd>{detail.boundary}</dd>
            </div>
            <div>
              <dt>所处阶段</dt>
              <dd>{detail.stage}</dd>
            </div>
            {detail.failureReason !== null ? (
              <div data-tone="danger">
                <dt>失败原因</dt>
                <dd>{detail.failureReason}</dd>
              </div>
            ) : null}
          </dl>
          {detail.legacyNote !== null ? (
            <p className="wb-hist__legacy-note">{detail.legacyNote}</p>
          ) : null}
          <p className="wb-hist__note">
            <LockKeyhole aria-hidden="true" />
            {detail.readonlyNote}
          </p>
        </div>
      </div>
    </div>
  )
}

/**
 * AI 历史：当前场景的真实操作摘要列表与标签内只读详情。记录字段只来自
 * `SceneGenerationHistorySummaryVO`；不展示操作标识、路径、候选或分叉入口。
 */
export function GenerationHistory({
  client,
  projectId,
  sceneId,
  refreshKey,
  activeStatus = null,
  canCancel = false,
  cancelBusy = false,
  onCancel,
  onOpenRun
}: GenerationHistoryProps): ReactElement {
  const history = useGenerationHistory({ client, projectId, sceneId, refreshKey })
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const backRef = useRef<HTMLButtonElement | null>(null)
  const rowRefs = useRef(new Map<string, HTMLButtonElement>())
  const lastOpened = useRef<string | null>(null)
  const selected =
    selectedId === null
      ? null
      : (history.items.find((item) => item.checkpointId === selectedId) ?? null)
  const detailId = selected?.checkpointId ?? null
  const historyError = history.error
  const historyCount = history.items.length
  const retryHistory = history.retry
  const activeRow = activeHistoryRowViewOf(activeStatus)
  const showEmptyState = history.view === 'empty' && activeRow === null

  useEffect(() => {
    if (detailId !== null) {
      backRef.current?.focus()
      return
    }
    const previous = lastOpened.current
    if (previous === null) return
    rowRefs.current.get(previous)?.focus()
    lastOpened.current = null
  }, [detailId])

  useEffect(() => {
    if (historyError !== null && historyCount > 0) {
      toast.error(historyError, {
        id: 'generation-history-error',
        description: '已保留当前列表。',
        duration: 8000,
        action: { label: '重试', onClick: () => retryHistory() }
      })
      return
    }
    toast.dismiss('generation-history-error')
  }, [historyError, historyCount, retryHistory])

  if (selected) {
    return <HistoryDetail backRef={backRef} onBack={() => setSelectedId(null)} record={selected} />
  }

  return (
    <div className="wb-hist wb-hist-page">
      <div className="wb-hist__head">
        <div className="wb-hist__title">
          <History aria-hidden="true" />
          <h2>AI 历史</h2>
          <p>
            {history.items.length > 0
              ? `当前场景 · 已读取 ${history.items.length} 条`
              : '当前场景的生成记录'}
          </p>
        </div>
        <span className="wb-hist__readonly">
          <LockKeyhole aria-hidden="true" />
          只读摘要
        </span>
      </div>

      <div
        aria-busy={history.loading || history.loadingMore}
        aria-label="AI 历史记录"
        className="wb-hist__scroll"
        role="region"
        tabIndex={0}
      >
        {activeRow !== null ? (
          <div className="wb-hist__active" data-tone={activeRow.tone}>
            <div className="wb-hist__active-main">
              <span className="wb-hist__active-kicker">进行中</span>
              <HistoryStatusBadge label={activeRow.status} tone={activeRow.tone} />
              <span className="wb-hist__active-message">{activeRow.message}</span>
            </div>
            <div className="wb-hist__active-actions">
              {onOpenRun !== undefined ? (
                <button className="wb-hist__active-open" onClick={onOpenRun} type="button">
                  查看运行详情
                </button>
              ) : null}
              {activeRow.canCancel && canCancel && onCancel !== undefined ? (
                <button
                  className="wb-hist__active-cancel"
                  disabled={cancelBusy}
                  onClick={onCancel}
                  type="button"
                >
                  {cancelBusy ? '正在取消…' : '取消'}
                </button>
              ) : null}
            </div>
          </div>
        ) : null}

        {history.view === 'loading' ? <HistorySkeleton /> : null}

        {history.view === 'error' ? (
          <div className="wb-hist__state" role="alert">
            <span aria-hidden="true" className="wb-hist__state-mark">
              <CircleAlert />
            </span>
            <h3>AI 历史没有读出来</h3>
            <p>{history.error ?? '请稍后重试。'}</p>
            <button className="wb-hist__retry" onClick={history.reload} type="button">
              <RefreshCw aria-hidden="true" />
              重新读取
            </button>
          </div>
        ) : null}

        {showEmptyState ? <HistoryEmpty /> : null}

        {history.view === 'ready' ? (
          <>
            <ol aria-label="当前场景的 AI 历史记录" className="wb-hist__list">
              {history.items.map((item) => {
                const row = historyRowViewOf(item)
                return (
                  <li className="wb-hist__item" key={item.checkpointId}>
                    <span aria-hidden="true" className="wb-hist__node" />
                    <button
                      className="wb-hist__row"
                      onClick={() => {
                        lastOpened.current = item.checkpointId
                        setSelectedId(item.checkpointId)
                      }}
                      ref={(node) => {
                        if (node) {
                          rowRefs.current.set(item.checkpointId, node)
                          return
                        }
                        rowRefs.current.delete(item.checkpointId)
                      }}
                      title={row.summary}
                      type="button"
                    >
                      <span className="wb-hist__time">{row.time}</span>
                      <span className="wb-hist__main">
                        <HistoryStatusBadge label={row.status} tone={row.tone} />
                        <span className="wb-hist__message">{row.summary}</span>
                      </span>
                      <ChevronRight aria-hidden="true" className="wb-hist__chevron" />
                    </button>
                  </li>
                )
              })}
            </ol>

            <div className="wb-hist__footer">
              <span className="wb-hist__count">已读取 {history.items.length} 条</span>
              {history.hasMore ? (
                <button
                  className="wb-hist__more"
                  disabled={history.loadingMore}
                  onClick={history.loadMore}
                  type="button"
                >
                  {history.loadingMore ? '正在读取…' : '加载更多'}
                </button>
              ) : (
                <span className="wb-hist__end">已经到最早一条</span>
              )}
            </div>
          </>
        ) : null}
      </div>
    </div>
  )
}
