import {
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  Clock3,
  GitBranch,
  History,
  LockKeyhole,
  RefreshCw
} from 'lucide-react'
import { useEffect, useRef, useState, type ReactElement, type RefObject } from 'react'
import { toast } from 'sonner'

import type {
  SceneGenerationForkVO,
  SceneGenerationHistoryDetailVO,
  SceneGenerationHistorySummaryVO,
  SceneGenerationRenderStatusVO
} from '@application/scene-generation/vo/SceneGenerationRenderVO'
import { Button } from '@presentation/components/ui/button'
import type { SceneGenerationClient } from '@interfaces/scene-generation/client/SceneGenerationClient'
import {
  activeHistoryRowViewOf,
  historyClock,
  historyDetailViewOf,
  historyForkAcknowledgeAction,
  historyForkCreateAgainAction,
  historyForkCreatedActiveHint,
  historyForkCreatedHint,
  historyForkCreatedMessage,
  historyForkCreatedTitle,
  historyForkFeedbackOf,
  historyForkRefreshAction,
  historyForkRecheckAction,
  historyForkRecheckingAction,
  historyForkUnconfirmedMessage,
  historyForkUnconfirmedStatusCopy,
  historyForkUnconfirmedTitle,
  historyForkUnknownBannerStatusCopy,
  historyForkUnknownBannerTitle,
  historyForkViewListAction,
  historyRowViewOf,
  unfinishedOperationRowViewOf,
  type HistoryBoundaryTone,
  type HistoryForkFeedback
} from './generationHistoryPresentation'
import type { HistoryForkSource } from './generationPresentation'
import type { ForkFromHistoryOutcome } from './useGenerationActions'
import { useGenerationHistory } from './useGenerationHistory'
import { useGenerationHistoryDetail } from './useGenerationHistoryDetail'
import type {
  DiscoveryRefreshResult,
  ForkUnknownController,
  ForkUnknownEntry,
  ForkUnknownSource
} from './useForkUnknownRegistry'
import './generationHistory.css'

interface GenerationHistoryProps {
  client: SceneGenerationClient
  projectId: string
  sceneId: string
  refreshKey?: string
  activeStatus?: SceneGenerationRenderStatusVO | null
  /** 没有检查点的未完成操作；它们不是历史条目，选择只切换当前视图。 */
  unfinished?: readonly SceneGenerationRenderStatusVO[]
  /** 选择未完成操作；调用方只应用安全状态，不恢复。 */
  onSelectUnfinished?: (operationId: string) => void
  canCancel?: boolean
  cancelBusy?: boolean
  onCancel?: () => void
  onOpenRun?: () => void
  /** 从历史创建新分支；`viewSwitched` 说明页面是否已采纳新操作。 */
  forkFromHistory: (source: HistoryForkSource) => Promise<ForkFromHistoryOutcome>
  /** 新分支状态已写入页面；调用方负责切换到当前运行标签。 */
  onForked: (fork: SceneGenerationForkVO) => void
  /**
   * 刷新页面级场景发现。创建成功但视图未切换时，没有检查点的新分支
   * 只能通过这次重读进入“需要处理的操作”；未知核对必须等待它完成。
   */
  onRefreshDiscovery: () => Promise<DiscoveryRefreshResult>
  /** 页面级未知分叉登记；跨历史标签与抽屉卸载保留，按工程/场景/来源隔离。 */
  forkUnknown: ForkUnknownController
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

function HistoryForkSection({
  detail,
  loading,
  error,
  forking,
  forkFeedback,
  onFork,
  onRefreshHistory,
  onRecheckFork,
  onBackToList,
  onRetryDetail,
  actionRef
}: {
  detail: SceneGenerationHistoryDetailVO | null
  loading: boolean
  error: string | null
  forking: boolean
  forkFeedback: HistoryForkFeedback | null
  onFork: () => void
  onRefreshHistory: () => void
  onRecheckFork: () => void
  onBackToList: () => void
  onRetryDetail: () => void
  actionRef: RefObject<HTMLButtonElement | null>
}): ReactElement {
  if (error !== null) {
    return (
      <div className="wb-hist__fork wb-hist__fork--error" role="alert">
        <p className="wb-hist__fork-title">
          <CircleAlert aria-hidden="true" />
          分叉资格没有读出来
        </p>
        <p className="wb-hist__fork-copy">{error}</p>
        <Button className="wb-gen-secondary" onClick={onRetryDetail} type="button">
          <RefreshCw aria-hidden="true" />
          重新核对
        </Button>
      </div>
    )
  }

  if (forkFeedback?.kind === 'unconfirmed') {
    return (
      <div className="wb-hist__fork wb-hist__fork--unconfirmed" role="status">
        <p className="wb-hist__fork-title">
          <CircleAlert aria-hidden="true" />
          {historyForkUnconfirmedTitle}
        </p>
        <p className="wb-hist__fork-copy">{forkFeedback.message}</p>
        <p className="wb-hist__fork-copy">{historyForkUnconfirmedMessage}</p>
        <p className="wb-hist__fork-copy wb-hist__fork-copy--quiet">
          {historyForkUnconfirmedStatusCopy(
            forkFeedback.checkStatus,
            forkFeedback.failureMessage
          )}
        </p>
        <div className="wb-hist__fork-actions">
          <Button
            className="wb-gen-primary wb-hist__fork-action"
            disabled={forkFeedback.checkStatus === 'checking'}
            onClick={onRecheckFork}
            ref={actionRef}
            type="button"
          >
            <RefreshCw aria-hidden="true" />
            {forkFeedback.checkStatus === 'checking'
              ? historyForkRecheckingAction
              : historyForkRecheckAction}
          </Button>
          <button className="wb-hist__fork-retry" onClick={onBackToList} type="button">
            {historyForkViewListAction}
          </button>
        </div>
      </div>
    )
  }

  if (forkFeedback?.kind === 'created') {
    return (
      <div className="wb-hist__fork wb-hist__fork--created" role="status">
        <p className="wb-hist__fork-title">
          <GitBranch aria-hidden="true" />
          {historyForkCreatedTitle}
        </p>
        <p className="wb-hist__fork-copy">{historyForkCreatedMessage}</p>
        <Button
          className="wb-gen-primary wb-hist__fork-action"
          onClick={onRefreshHistory}
          ref={actionRef}
          type="button"
        >
          <RefreshCw aria-hidden="true" />
          {historyForkRefreshAction}
        </Button>
        <p className="wb-hist__fork-copy wb-hist__fork-copy--quiet">
          {forkFeedback.branchActive
            ? historyForkCreatedActiveHint
            : historyForkCreatedHint}
        </p>
        {forkFeedback.branchActive ? null : (
          <button className="wb-hist__fork-retry" onClick={onFork} type="button">
            {historyForkCreateAgainAction}
          </button>
        )}
      </div>
    )
  }

  if (loading || detail === null) {
    return (
      <div aria-live="polite" className="wb-hist__fork">
        <p className="wb-hist__fork-loading" role="status">
          正在核对这条记录的复制资格…
        </p>
      </div>
    )
  }

  if (!detail.canFork) {
    return (
      <div className="wb-hist__fork wb-hist__fork--blocked">
        <p className="wb-hist__fork-title">
          <LockKeyhole aria-hidden="true" />
          不能从这里分叉
        </p>
        <p className="wb-hist__fork-copy">{detail.forkReason ?? '这条记录不能分叉。'}</p>
      </div>
    )
  }

  return (
    <div className="wb-hist__fork">
      <p className="wb-hist__fork-title">
        <GitBranch aria-hidden="true" />
        从这里分叉
      </p>
      <p className="wb-hist__fork-copy">
        会把这条记录的候选复制到新分支；原记录、原分支和正式作品都保持不变。
      </p>
      <Button
        aria-busy={forking}
        className="wb-gen-primary wb-hist__fork-action"
        disabled={forking}
        onClick={onFork}
        ref={actionRef}
        type="button"
      >
        {forking ? (
          <>
            <span aria-hidden="true" className="wb-gen-spinner" />
            正在创建分支…
          </>
        ) : (
          <>
            <GitBranch aria-hidden="true" />
            从这里分叉
          </>
        )}
      </Button>
      {forkFeedback?.kind === 'failed' ? (
        <div className="wb-hist__fork-error" role="alert">
          <CircleAlert aria-hidden="true" />
          <div>
            <p>{forkFeedback.message}</p>
            <p>原记录和分支保持不变，可以直接重试。</p>
          </div>
        </div>
      ) : null}
    </div>
  )
}

export function HistoryDetail({
  backRef,
  onBack,
  record,
  detail,
  detailLoading,
  detailError,
  forking,
  forkFeedback,
  onFork,
  onRefreshHistory,
  onRecheckFork,
  onRetryDetail
}: {
  backRef: RefObject<HTMLButtonElement | null>
  onBack: () => void
  record: SceneGenerationHistorySummaryVO
  detail: SceneGenerationHistoryDetailVO | null
  detailLoading: boolean
  detailError: string | null
  forking: boolean
  forkFeedback: HistoryForkFeedback | null
  onFork: () => void
  onRefreshHistory: () => void
  onRecheckFork: () => void
  onRetryDetail: () => void
}): ReactElement {
  const detailView = historyDetailViewOf(record)
  const forkActionRef = useRef<HTMLButtonElement | null>(null)
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
            {detailView.clock}
          </p>
          <h2 className="wb-hist__detail-title">{detailView.summary}</h2>
          <div className="wb-hist__detail-badges">
            <HistoryStatusBadge label={detailView.boundary} tone={detailView.tone} />
          </div>
          <dl className="wb-hist__meta">
            <div>
              <dt>记录时间</dt>
              <dd>{detailView.time}</dd>
            </div>
            <div>
              <dt>操作边界</dt>
              <dd>{detailView.boundary}</dd>
            </div>
            <div>
              <dt>所处阶段</dt>
              <dd>{detailView.stage}</dd>
            </div>
            {detailView.failureReason !== null ? (
              <div data-tone="danger">
                <dt>失败原因</dt>
                <dd>{detailView.failureReason}</dd>
              </div>
            ) : null}
          </dl>
          <HistoryForkSection
            actionRef={forkActionRef}
            detail={detail}
            error={detailError}
            forkFeedback={forkFeedback}
            forking={forking}
            loading={detailLoading}
            onBackToList={onBack}
            onFork={onFork}
            onRecheckFork={onRecheckFork}
            onRefreshHistory={onRefreshHistory}
            onRetryDetail={onRetryDetail}
          />
          <p className="wb-hist__note">
            <LockKeyhole aria-hidden="true" />
            {detailView.readonlyNote}
          </p>
        </div>
      </div>
    </div>
  )
}

/**
 * 每条历史一个实例；检查点键重挂载会自然清空分叉忙态与反馈，
 * 不需要在 effect 内同步重置状态。创建成功且已切走时只切页和刷新列表；
 * 创建成功但视图未切换时保留创建事实和找回入口，不写成可重试失败。
 */
function HistoryDetailLoader({
  backRef,
  client,
  forkFromHistory,
  onBack,
  onForked,
  onHistoryReload,
  onRefreshDiscovery,
  unknownFork,
  onUnknownFork,
  onRecheckFork,
  record
}: {
  backRef: RefObject<HTMLButtonElement | null>
  client: SceneGenerationClient
  forkFromHistory: (source: HistoryForkSource) => Promise<ForkFromHistoryOutcome>
  onBack: () => void
  onForked: (fork: SceneGenerationForkVO) => void
  onHistoryReload: () => void
  /** 刷新页面级场景发现；未知核对只在它真正结束后才更新状态。 */
  onRefreshDiscovery: () => Promise<DiscoveryRefreshResult>
  /** 这条记录仍有未确认的分叉结果；重开后继续保持未知，不回到普通分叉入口。 */
  unknownFork: ForkUnknownEntry | null
  onUnknownFork: (
    source: ForkUnknownSource,
    sourceSummary: string,
    message: string
  ) => void
  onRecheckFork: (source: ForkUnknownSource) => void
  record: SceneGenerationHistorySummaryVO
}): ReactElement {
  const detail = useGenerationHistoryDetail({ client, record })
  const [forking, setForking] = useState(false)
  const [forkFeedback, setForkFeedback] = useState<HistoryForkFeedback | null>(null)
  const forkGuard = useRef(false)
  const reloadDetail = detail.reload

  const retryDetail = (): void => {
    setForkFeedback(null)
    reloadDetail()
  }

  /** 已创建但未切换：先把新分支读进页面发现，再回列表让作者自己找。 */
  const refreshAfterFork = (): void => {
    onHistoryReload()
    void onRefreshDiscovery()
    onBack()
  }

  /** 通信未知的核对由页面级登记执行；这里只触发，不猜测结果。 */
  const recheckFork = (): void => {
    onRecheckFork(record)
  }

  const fork = async (): Promise<void> => {
    if (!detail.detail?.canFork || forkGuard.current) return
    forkGuard.current = true
    setForking(true)
    setForkFeedback(null)
    try {
      const outcome = await forkFromHistory({
        projectId: record.projectId,
        sceneId: record.sceneId,
        threadId: record.threadId,
        branchId: record.branchId,
        checkpointId: record.checkpointId
      })
      if (outcome.kind === 'forked') {
        const source = outcome.fork.source
        const label =
          source.createdAt === undefined
            ? source.summary
            : `${historyClock(source.createdAt)} · ${source.summary}`
        if (outcome.viewSwitched) {
          onHistoryReload()
          toast.success(`已从「${label}」创建新分支`, {
            id: 'generation-fork-success',
            description: '原记录和正式作品保持不变，已切换到新分支。',
            duration: 8000
          })
          onForked(outcome.fork)
          return
        }
        toast.success(`已从「${label}」创建新分支`, {
          id: 'generation-fork-success',
          description:
            '原记录和正式作品保持不变；没有自动切换视图，新分支可从 AI 历史找到。',
          duration: 8000
        })
        /* 只刷新发现列表，不抢当前视图；作者回到 AI 历史即可看到新分支。 */
        void onRefreshDiscovery()
      }
      const feedback = historyForkFeedbackOf(outcome)
      if (feedback === null) return
      if (feedback.kind === 'unconfirmed') {
        onUnknownFork(record, record.message, feedback.message)
      }
      setForkFeedback(feedback)
    } finally {
      forkGuard.current = false
      setForking(false)
    }
  }

  const feedback: HistoryForkFeedback | null =
    unknownFork === null
      ? forkFeedback
      : {
          kind: 'unconfirmed',
          message: unknownFork.message,
          checkStatus: unknownFork.status,
          failureMessage: unknownFork.failureMessage
        }

  return (
    <HistoryDetail
      backRef={backRef}
      detail={detail.detail}
      detailError={detail.error}
      detailLoading={detail.loading}
      forkFeedback={feedback}
      forking={forking}
      onBack={onBack}
      onFork={() => void fork()}
      onRecheckFork={recheckFork}
      onRefreshHistory={refreshAfterFork}
      onRetryDetail={retryDetail}
      record={record}
    />
  )
}

/**
 * AI 历史：当前场景的真实操作摘要列表与标签内只读详情。记录字段只来自
 * `SceneGenerationHistorySummaryVO`；详情按需读取后端证明的分叉资格。
 * 不展示操作标识、路径或检查点内部。
 */
export function GenerationHistory({
  client,
  projectId,
  sceneId,
  refreshKey,
  activeStatus = null,
  unfinished = [],
  onSelectUnfinished,
  canCancel = false,
  cancelBusy = false,
  onCancel,
  onOpenRun,
  forkFromHistory,
  onForked,
  onRefreshDiscovery,
  forkUnknown
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
  const selectedUnknownFork =
    selected === null ? null : forkUnknown.find(selected)
  const historyError = history.error
  const historyCount = history.items.length
  const retryHistory = history.retry
  const activeRow = activeHistoryRowViewOf(activeStatus)
  const visibleUnfinished = unfinished.filter(
    (operation) => operation.operationId !== activeStatus?.operationId
  )
  const showEmptyState =
    history.view === 'empty' && activeRow === null && visibleUnfinished.length === 0

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

  const recheckUnknownFork = (source: ForkUnknownSource): void => {
    void forkUnknown.recheck(source, {
      history: history.reload,
      discovery: onRefreshDiscovery
    })
  }

  if (selected) {
    return (
      <HistoryDetailLoader
        backRef={backRef}
        client={client}
        forkFromHistory={forkFromHistory}
        key={selected.checkpointId}
        onBack={() => setSelectedId(null)}
        onForked={onForked}
        onHistoryReload={history.reload}
        onRecheckFork={recheckUnknownFork}
        onRefreshDiscovery={onRefreshDiscovery}
        onUnknownFork={forkUnknown.markUnknown}
        record={selected}
        unknownFork={selectedUnknownFork}
      />
    )
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
        {forkUnknown.entries.length > 0 ? (
          <section
            aria-label={historyForkUnknownBannerTitle}
            className="wb-hist__fork-unknown"
            role="status"
          >
            <div className="wb-hist__fork-unknown-head">
              <CircleAlert aria-hidden="true" />
              <p className="wb-hist__fork-unknown-title">
                {historyForkUnknownBannerTitle}
              </p>
              <span className="wb-hist__count">{forkUnknown.entries.length} 项</span>
            </div>
            <ul className="wb-hist__fork-unknown-list">
              {forkUnknown.entries.map((entry) => (
                <li className="wb-hist__fork-unknown-item" key={entry.key}>
                  <p className="wb-hist__fork-unknown-copy">
                    来源「{entry.sourceSummary}」：{entry.message}
                  </p>
                  <p className="wb-hist__fork-unknown-copy">
                    {historyForkUnknownBannerStatusCopy(
                      entry.status,
                      entry.failureMessage
                    )}
                  </p>
                  <div className="wb-hist__fork-unknown-actions">
                    <button
                      className="wb-hist__fork-unknown-recheck"
                      disabled={entry.status === 'checking'}
                      onClick={() => recheckUnknownFork(entry)}
                      type="button"
                    >
                      <RefreshCw aria-hidden="true" />
                      {entry.status === 'checking'
                        ? historyForkRecheckingAction
                        : historyForkRecheckAction}
                    </button>
                    <button
                      className="wb-hist__fork-unknown-ack"
                      onClick={() => forkUnknown.acknowledge(entry)}
                      type="button"
                    >
                      {historyForkAcknowledgeAction}
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        {visibleUnfinished.length > 0 ? (
          <section aria-label="需要处理的操作" className="wb-hist__unfinished">
            <div className="wb-hist__unfinished-head">
              <span className="wb-hist__unfinished-title">需要处理的操作</span>
              <span className="wb-hist__count">{visibleUnfinished.length} 项</span>
            </div>
            <p className="wb-hist__unfinished-note">
              会阻止新生成的进行中记录也能从这里打开；没有检查点的遗留可以继续，
              写入或提交回执不明的记录可以重新核对。选择只切换当前视图，不会自动继续或调用模型。
            </p>
            <ol className="wb-hist__unfinished-list">
              {visibleUnfinished.map((operation) => {
                const row = unfinishedOperationRowViewOf(operation)
                return (
                  <li className="wb-hist__unfinished-item" key={operation.operationId}>
                    <button
                      className="wb-hist__unfinished-row"
                      disabled={onSelectUnfinished === undefined}
                      onClick={() => onSelectUnfinished?.(operation.operationId)}
                      title={row.message}
                      type="button"
                    >
                      <span className="wb-hist__time">{row.time}</span>
                      <span className="wb-hist__main">
                        <HistoryStatusBadge label={row.status} tone={row.tone} />
                        <span className="wb-hist__message">{row.message}</span>
                        {row.canResume ? (
                          <span className="wb-hist__unfinished-flag">可继续</span>
                        ) : row.canVerify ? (
                          <span className="wb-hist__unfinished-flag" data-tone="wait">
                            待核对
                          </span>
                        ) : null}
                      </span>
                      <ChevronRight aria-hidden="true" className="wb-hist__chevron" />
                    </button>
                  </li>
                )
              })}
            </ol>
          </section>
        ) : null}

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
