import {
  ArrowRight,
  Check,
  CircleAlert,
  Clock3,
  Gamepad2,
  Layers,
  LockKeyhole,
  Package,
  Play,
  RefreshCw,
  SearchCheck,
  Sparkles,
  X
} from 'lucide-react'
import { useState, type ReactElement, type ReactNode } from 'react'

import type {
  SceneGenerationKnownIssueVO,
  SceneGenerationRenderStatusVO
} from '@application/scene-generation/vo/SceneGenerationRenderVO'
import {
  Conversation,
  ConversationContent,
  ConversationEmptyState,
  ConversationScrollButton
} from '@presentation/components/ai-elements/conversation'
import { Message, MessageContent } from '@presentation/components/ai-elements/message'
import { Button } from '@presentation/components/ui/button'
import { ContentKindIcon } from '@presentation/features/workbench-session/ContentKindIcon'
import type { SessionCard } from '@presentation/features/workbench-session/workbenchSession.types'
import { useCandidatePreviewTab } from '../candidate/candidatePreviewContext'
import { SceneArt } from './SceneArt'
import { GenerationInteraction } from './GenerationInteraction'
import { GenerationRunDetails, GenerationRunStrip } from './GenerationRunDetails'
import {
  countCanvasCards,
  inputSourceTextOf,
  interruptionNoteOf,
  orderedOutcomeActions,
  outcomeActionLabel,
  outcomeNextStepOf,
  repairRetryViewOf,
  userMessageLabelOf,
  type GenerationActionFailure,
  type GenerationActionKind,
  type GenerationDraft,
  type GenerationOutcomeActionId,
  type GenerationProgressStep,
  type RepairRetryView
} from './generationPresentation'
import {
  generationRunActionsOf,
  generationRunViewOf,
  type GenerationRunView
} from './generationRunView'
import { historySecondTime } from './generationHistoryPresentation'

interface GenerationConversationProps {
  status: SceneGenerationRenderStatusVO | null
  cards: readonly SessionCard[]
  progress: readonly GenerationProgressStep[]
  draft: GenerationDraft
  pending: boolean
  pendingAction: GenerationActionKind | null
  actionError: GenerationActionFailure | null
  loading: boolean
  loadError: string | null
  projectName: string
  sceneLabel: string
  startBlockedReason: string | null
  /** 启动被已有生成挡住；只有该原因下提供 AI 历史处理入口。 */
  startBlockedByGeneration: boolean
  /** 修复重跑自己的禁用依据；不包含已有生成冲突。 */
  repairBlockedReason: string | null
  startPhase: 'saving' | 'preparing' | null
  reviseOpen: boolean
  exportDisabled?: boolean
  exportHint?: string
  exporting?: boolean
  onExport?: () => void
  onStart: () => void
  onOpenSummary?: () => void
  onOpenHistory?: () => void
  onReturnToCanvas?: () => void
  onReload: () => void
  onResume: () => void
  /** 旧壳不传时不显示核对结果动作。 */
  onVerifyResult?: () => void
  onRetryCleanup?: () => void
  onRetryRepair: () => void
  onCancel: () => void
  onOpenWorks: () => void
  onOpenRevise: () => void
  onSelectOption: (optionId: string | null) => void
  onSelectAnswer: (questionId: string, optionId: string | null) => void
  onAnswerBodyChange: (questionId: string, body: string) => void
  onBodyChange: (body: string) => void
  onSubmitPrimary: () => void
  onAccept: () => void
  onDiscard: () => void
}

function UserBubble({
  children,
  meta = '你',
  readOnly = false
}: {
  children: ReactNode
  meta?: string
  readOnly?: boolean
}): ReactElement {
  return (
    <div
      className={
        readOnly
          ? 'wb-gen-msg wb-gen-msg--user wb-gen-msg--readonly'
          : 'wb-gen-msg wb-gen-msg--user'
      }
      data-gen-motion="message"
    >
      <div className="wb-gen-msg__stack">
        <span className="wb-gen-msg__meta">{meta}</span>
        <Message className="wb-gen-msg__root" from="user">
          <MessageContent className="wb-gen-bubble wb-gen-bubble--user">{children}</MessageContent>
        </Message>
      </div>
      <span aria-hidden="true" className="wb-gen-avatar wb-gen-avatar--user">
        <svg fill="none" viewBox="0 0 24 24">
          <circle cx="12" cy="8.2" r="3.6" stroke="currentColor" strokeWidth="1.7" />
          <path
            d="M5.4 20c.8-3.6 3.4-5.4 6.6-5.4s5.8 1.8 6.6 5.4"
            stroke="currentColor"
            strokeLinecap="round"
            strokeWidth="1.7"
          />
        </svg>
      </span>
    </div>
  )
}

function AssistantBubble({
  children,
  tone = 'plain',
  outcome
}: {
  children: ReactNode
  tone?: 'plain' | 'wide'
  outcome?: 'paused' | 'failed' | 'cancelled'
}): ReactElement {
  return (
    <div className="wb-gen-msg wb-gen-msg--assistant" data-gen-motion="message">
      <span aria-hidden="true" className="wb-gen-avatar wb-gen-avatar--assistant">
        <Sparkles />
      </span>
      <div className="wb-gen-msg__stack">
        <span className="wb-gen-msg__meta">AI</span>
        <Message className="wb-gen-msg__root" from="assistant">
          <MessageContent
            className={`wb-gen-bubble${tone === 'wide' ? ' wb-gen-bubble--wide' : ''}${
              outcome ? ' wb-gen-bubble--outcome' : ''
            }`}
            data-outcome={outcome}
          >
            {children}
          </MessageContent>
        </Message>
      </div>
    </div>
  )
}

function DigestIcon({ kind }: { kind: string }): ReactElement {
  switch (kind) {
    case 'document':
      return <ContentKindIcon contentKind="text" textKind="document" />
    case 'prompt':
      return <ContentKindIcon contentKind="text" textKind="prompt" />
    case 'image':
    case 'audio':
    case 'video':
      return <ContentKindIcon contentKind={kind} />
    default:
      return <Layers />
  }
}

function EmptyGeneration({
  cards,
  projectName,
  sceneLabel,
  loading,
  loadError,
  blockedReason,
  startPhase,
  pending,
  failure,
  onStart,
  onOpenSummary,
  onOpenHistory,
  onReload
}: {
  cards: readonly SessionCard[]
  projectName: string
  sceneLabel: string
  loading: boolean
  loadError: string | null
  blockedReason: string | null
  startPhase: 'saving' | 'preparing' | null
  pending: boolean
  failure: GenerationActionFailure | null
  onStart: () => void
  onOpenSummary?: () => void
  onOpenHistory?: () => void
  onReload: () => void
}): ReactElement {
  const busy = pending && startPhase !== null
  const workspaceNotReady = failure?.workspaceNotReady === true
  const digest = countCanvasCards(cards).filter(
    (entry) => entry.count > 0 && entry.key !== 'animation' && entry.key !== 'effect'
  )
  return (
    <ConversationEmptyState className="wb-gen-empty-host">
      <div className="wb-gen-empty">
        <div className="wb-gen-empty__hero" data-gen-motion="hero">
          <span aria-hidden="true" className="wb-gen-empty__halo" />
          <svg aria-hidden="true" className="wb-gen-empty__orbit" fill="none" viewBox="0 0 400 320">
            <ellipse cx="200" cy="166" rx="186" ry="132" />
            <ellipse cx="200" cy="166" rx="150" ry="104" />
          </svg>
          <SceneArt animated />
          <span className="wb-gen-empty__chip wb-gen-empty__chip--one">
            <i />
            {loading ? '正在核对任务' : '已保存编排'}
          </span>
          <span className="wb-gen-empty__chip wb-gen-empty__chip--two">
            <i />
            {loading ? '状态待确认' : '尚未开始生成'}
          </span>
        </div>

        <div className="wb-gen-empty__copy" data-gen-motion="copy">
          <p className="wb-gen-empty__scope">{projectName}</p>
          <h2>{sceneLabel}</h2>
        </div>

        {digest.length > 0 ? (
          <ul aria-label="已保存输入构成" className="wb-gen-empty__digest">
            {digest.map((entry) => (
              <li data-kind={entry.key} key={entry.key}>
                <span aria-hidden="true" className="wb-gen-empty__digest-icon">
                  <DigestIcon kind={entry.key} />
                </span>
                <span>{entry.label}</span>
                <strong>{entry.count}</strong>
              </li>
            ))}
          </ul>
        ) : (
          <p className="wb-gen-empty__digest-empty">画布上还没有可纳入生成的输入。</p>
        )}

        <div className="wb-gen-empty__actions" data-gen-motion="actions">
          <button
            className="wb-gen-empty__primary"
            disabled={pending || blockedReason !== null || workspaceNotReady}
            data-guide-target="generation-start"
            onClick={onStart}
            type="button"
          >
            <span aria-hidden="true" className="wb-gen-empty__icon">
              <Sparkles />
            </span>
            <span className="wb-gen-empty__label">
              <strong>
                {busy ? (startPhase === 'saving' ? '正在保存画布' : '正在准备生成') : '开始生成'}
              </strong>
              <small>
                {workspaceNotReady
                  ? '这一场暂时不能开始'
                  : (blockedReason ??
                    (loading
                      ? '正在核对当前场景是否已有任务'
                      : '读取已保存编排 · 不启动第二次任务'))}
              </small>
            </span>
            <ArrowRight className="wb-gen-empty__arrow" />
          </button>
          <div className="wb-gen-empty__links">
            {onOpenSummary ? (
              <button
                data-guide-target="generation-summary"
                className="wb-gen-empty__link"
                onClick={onOpenSummary}
                type="button"
              >
                查看输入摘要
              </button>
            ) : null}
            {onOpenHistory ? (
              <button className="wb-gen-empty__link" onClick={onOpenHistory} type="button">
                查看 AI 历史
              </button>
            ) : null}
            {loadError ? (
              <button className="wb-gen-empty__link" onClick={onReload} type="button">
                重新核对任务
              </button>
            ) : null}
          </div>
          {failure ? (
            <p className="wb-gen-empty__failure" role="alert">
              <CircleAlert />
              {failure.message}
            </p>
          ) : null}
          {loadError ? (
            <p className="wb-gen-empty__failure" role="status">
              <CircleAlert />
              {loadError}
            </p>
          ) : null}
          <span className="wb-gen-empty__footnote">
            <LockKeyhole />
            关闭抽屉不会取消生成；重新打开会重新核对状态。
          </span>
        </div>
      </div>
    </ConversationEmptyState>
  )
}

function ResultOrb({
  tone,
  children
}: {
  tone: 'done' | 'danger' | 'muted' | 'wait'
  children: ReactNode
}): ReactElement {
  return (
    <span aria-hidden="true" className="wb-gen-result__orb" data-tone={tone}>
      {children}
    </span>
  )
}

function KnownIssueList({
  issues
}: {
  issues: readonly SceneGenerationKnownIssueVO[] | undefined
}): ReactElement | null {
  if (!issues || issues.length === 0) return null
  return (
    <ul aria-label="候选问题" className="wb-gen-issues">
      {issues.map((issue) => (
        <li key={issue.sequence === undefined ? issue.code : `${issue.code}:${issue.sequence}`}>
          {issue.message}
        </li>
      ))}
    </ul>
  )
}

function RetryRepairConfirm({
  view,
  pending,
  blockedReason,
  error,
  onConfirm,
  onCancel
}: {
  view: RepairRetryView
  pending: boolean
  blockedReason: string | null
  error: string | null
  onConfirm: () => void
  onCancel: () => void
}): ReactElement {
  return (
    <div aria-label="确认重试本次修改" className="wb-gen-retry" role="group">
      <div className="wb-gen-retry__head">
        <strong>将携带这次修改要求</strong>
        <span>新操作 · 原失败记录保持不变</span>
      </div>
      <blockquote className="wb-gen-retry__body">{view.instruction}</blockquote>
      <dl className="wb-gen-retry__facts">
        <div>
          <dt>上一候选</dt>
          <dd>只读参考，不沿用接受或修改权限</dd>
        </div>
        <div>
          <dt>输入来源</dt>
          <dd>{inputSourceTextOf(view.inputEntries)}</dd>
        </div>
      </dl>
      {blockedReason ? <p className="wb-gen-retry__note">{blockedReason}</p> : null}
      {error ? (
        <p className="wb-gen-retry__error" role="alert">
          <CircleAlert />
          {error}
        </p>
      ) : null}
      <div className="wb-gen-result__actions">
        <Button
          className="wb-gen-primary"
          disabled={pending || blockedReason !== null}
          onClick={onConfirm}
          type="button"
        >
          <Sparkles />
          {pending ? '正在重试本次修改…' : '确认重试本次修改'}
        </Button>
        <Button className="wb-gen-quiet" disabled={pending} onClick={onCancel} type="button">
          先不重试
        </Button>
      </div>
    </div>
  )
}

function FailureFacts({
  failure,
  hasPreviousCandidate
}: {
  failure: NonNullable<GenerationRunView['failure']>
  hasPreviousCandidate: boolean
}): ReactElement {
  return (
    <dl aria-label="失败诊断" className="wb-gen-outcome__facts">
      <div>
        <dt>操作时间</dt>
        <dd>{failure.recordedAt ? historySecondTime(failure.recordedAt) : '没有可用的操作时间'}</dd>
      </div>
      <div>
        <dt>故障指纹</dt>
        <dd>{failure.reference ?? '没有可用的诊断编号'}</dd>
      </div>
      <div>
        <dt>本轮候选</dt>
        <dd>{hasPreviousCandidate ? '上一候选可只读查看' : '没有可查看的候选'}</dd>
      </div>
    </dl>
  )
}

interface GenerationOutcomeBubbleProps {
  view: GenerationRunView
  status: SceneGenerationRenderStatusVO
  pending: boolean
  pendingAction: GenerationActionKind | null
  startBlockedReason: string | null
  /** 修复重跑自己的禁用依据；不含已有生成冲突。 */
  repairBlockedReason: string | null
  /** 启动被已有生成挡住；只在此时显示去 AI 历史的处理路径。 */
  startBlockedByGeneration: boolean
  retryError: string | null
  /** 本次显式核对的安全结论；缺失表示还没有核对。 */
  verifyMessage?: string | null
  onOpenHistory?: () => void
  onResume?: () => void
  onCancel?: () => void
  onVerifyResult?: () => void
  onRetryRepair?: () => void
  onRegenerate?: () => void
  onViewPreviousCandidate?: () => void
  onOpenSummary?: () => void
  onReturnToCanvas?: () => void
  onReload?: () => void
}

function outcomeIconOf(action: GenerationOutcomeActionId): ReactElement {
  switch (action) {
    case 'resume':
    case 'resume-unfinished':
      return <Play />
    case 'retry-cleanup':
      return <RefreshCw />
    case 'verify-result':
      return <SearchCheck />
    case 'retry-repair':
    case 'regenerate':
      return <Sparkles />
    case 'return-to-canvas':
      return <ArrowRight />
    case 'view-previous-candidate':
      return <Gamepad2 />
    case 'reload':
      return <RefreshCw />
    case 'open-summary':
      return <Layers />
    case 'cancel':
      return <X />
  }
}

function outcomePendingLabel(
  action: GenerationOutcomeActionId,
  label: string,
  pending: boolean,
  pendingAction: GenerationActionKind | null
): string {
  if (!pending) return label
  if (action === 'resume' && pendingAction === 'resume') return '正在继续…'
  if (action === 'resume-unfinished' && pendingAction === 'resumeUnfinished') return '正在继续…'
  if (action === 'retry-cleanup' && pendingAction === 'retryCleanup') return '正在重试清理…'
  if (action === 'verify-result' && pendingAction === 'verifyResult') return '正在核对…'
  if (action === 'cancel' && pendingAction === 'cancel') return '正在取消…'
  if (action === 'retry-repair' && pendingAction === 'retryRepair') return '正在重试本次修改…'
  if (action === 'regenerate' && pendingAction === 'start') return '正在准备生成…'
  return label
}

export function GenerationOutcomeBubble({
  view,
  status,
  pending,
  pendingAction,
  startBlockedReason,
  repairBlockedReason,
  startBlockedByGeneration,
  retryError,
  verifyMessage = null,
  onOpenHistory,
  onResume,
  onCancel,
  onVerifyResult,
  onRetryRepair,
  onRegenerate,
  onViewPreviousCandidate,
  onOpenSummary,
  onReturnToCanvas,
  onReload
}: GenerationOutcomeBubbleProps): ReactElement {
  const [retryConfirm, setRetryConfirm] = useState(false)
  const phase = view.phase
  const failure = view.failure
  const retry = failure?.canRetryRepair === true ? repairRetryViewOf(status) : null
  const situation = {
    phase,
    failureClass: view.failureClass,
    unverified: failure?.unverified === true
  }
  const handlers: Record<GenerationOutcomeActionId, (() => void) | null> = {
    resume: onResume ?? null,
    'resume-unfinished': null,
    'retry-cleanup': null,
    'verify-result': onVerifyResult ?? null,
    'retry-repair': retry?.eligible === true ? () => setRetryConfirm(true) : null,
    'view-previous-candidate': onViewPreviousCandidate ?? null,
    regenerate: onRegenerate ?? null,
    'return-to-canvas': onReturnToCanvas ?? null,
    reload: onReload ?? null,
    'open-summary': onOpenSummary ?? null,
    cancel: onCancel ?? null
  }
  const actions = orderedOutcomeActions(situation, generationRunActionsOf(view)).filter(
    (action) => handlers[action] !== null
  )
  const firstPrimary = actions.find((action) => action !== 'cancel') ?? actions[0]
  const nextStep = outcomeNextStepOf({
    phase,
    failureClass: view.failureClass,
    unverified: failure?.unverified === true,
    canResume: view.resume.canResume,
    resumeReason: view.resume.reason,
    interruptionNote: interruptionNoteOf(status),
    actions
  })
  const tone =
    phase === 'paused' || phase === 'cancelled'
      ? 'muted'
      : failure?.unverified === true
        ? 'wait'
        : 'danger'
  const kicker =
    phase === 'paused'
      ? '已暂停'
      : phase === 'cancelled'
        ? '已取消'
        : failure?.unverified === true
          ? '结果待核对'
          : view.runState === 'interrupted'
            ? '运行中断'
            : '生成失败'
  const title =
    phase === 'paused'
      ? view.resume.canResume
        ? '可以继续这次生成'
        : '这次生成不能继续'
      : phase === 'cancelled'
        ? '本次生成已结束'
        : (failure?.title ?? '生成没有完成')
  const reason =
    phase === 'paused'
      ? view.resume.canResume
        ? '输入、决定和候选都保持不变。'
        : (view.resume.reason ?? '这次运行不可续跑。')
      : phase === 'cancelled'
        ? '本次生成已取消。'
        : (failure?.message ?? status.stageMessage)

  return (
    <div className="wb-gen-outcome" data-outcome={phase}>
      <div className="wb-gen-outcome__head">
        <ResultOrb tone={tone}>{phase === 'failed' ? <CircleAlert /> : <Clock3 />}</ResultOrb>
        <div className="wb-gen-outcome__heading">
          <span className="wb-gen-outcome__kicker">{kicker}</span>
          <strong className="wb-gen-outcome__title">{title}</strong>
        </div>
      </div>

      <p className="wb-gen-outcome__reason">{reason}</p>
      {phase === 'failed' && failure ? (
        <FailureFacts failure={failure} hasPreviousCandidate={view.candidate.previous} />
      ) : null}
      {verifyMessage ? (
        <div className="wb-gen-outcome__next" role="status">
          <span>核对结果</span>
          <p>{verifyMessage}</p>
        </div>
      ) : null}
      {nextStep ? (
        <div className="wb-gen-outcome__next">
          <span>{phase === 'failed' ? '恢复' : '下一步'}</span>
          <p>{nextStep}</p>
        </div>
      ) : null}

      <KnownIssueList issues={status.knownIssues} />
      {view.candidate.previousNote ? (
        <p className="wb-gen-outcome__note">{view.candidate.previousNote}</p>
      ) : null}
      {startBlockedReason && phase !== 'paused' ? (
        <div className="wb-gen-outcome__blocked">
          <p className="wb-gen-outcome__blocker">{startBlockedReason}</p>
          {startBlockedByGeneration && onOpenHistory ? (
            <button className="wb-gen-result__link" onClick={onOpenHistory} type="button">
              去 AI 历史处理
              <ArrowRight />
            </button>
          ) : null}
        </div>
      ) : null}

      {retryConfirm && retry?.eligible ? (
        <RetryRepairConfirm
          blockedReason={repairBlockedReason}
          error={retryError}
          onCancel={() => setRetryConfirm(false)}
          onConfirm={() => onRetryRepair?.()}
          pending={pendingAction === 'retryRepair'}
          view={retry}
        />
      ) : actions.length === 0 ? (
        <p className="wb-gen-outcome__empty">当前没有可用的页面动作。</p>
      ) : (
        <div className="wb-gen-outcome__actions">
          {actions.map((action, index) => {
            const handler = handlers[action]
            if (!handler) return null
            const label = outcomeActionLabel(action, situation)
            const className =
              action === 'cancel'
                ? actions.length === 1
                  ? 'wb-gen-secondary'
                  : 'wb-gen-quiet'
                : action === firstPrimary
                  ? 'wb-gen-primary'
                  : index <= 1
                    ? 'wb-gen-secondary'
                    : 'wb-gen-quiet'
            return (
              <Button
                className={className}
                disabled={pending || (action === 'regenerate' && startBlockedReason !== null)}
                key={action}
                onClick={handler}
                type="button"
              >
                {outcomeIconOf(action)}
                {outcomePendingLabel(action, label, pending, pendingAction)}
              </Button>
            )
          })}
        </div>
      )}

      {retryError && retry?.eligible !== true ? (
        <p className="wb-gen-outcome__error" role="alert">
          <CircleAlert />
          {retryError}
        </p>
      ) : null}

      <div className="wb-gen-outcome__footer">
        <GenerationRunDetails label="查看运行详情" variant="quiet" view={view} />
      </div>
    </div>
  )
}

interface GenerationCompletedBubbleProps {
  pending: boolean
  startBlockedReason: string | null
  /** 启动被已有生成挡住；只在此时显示去 AI 历史的处理路径。 */
  startBlockedByGeneration: boolean
  onStart: () => void
  onOpenWorks: () => void
  onOpenHistory?: () => void
  cleanupPending?: boolean
  cleanupBusy?: boolean
  cleanupError?: string | null
  onRetryCleanup?: () => void
  onExport?: () => void
  exportDisabled?: boolean
  exportHint?: string
  exporting?: boolean
}

export function GenerationCompletedBubble({
  pending,
  startBlockedReason,
  startBlockedByGeneration,
  onStart,
  onOpenWorks,
  onOpenHistory,
  cleanupPending = false,
  cleanupBusy = false,
  cleanupError = null,
  onRetryCleanup,
  onExport,
  exportDisabled,
  exportHint,
  exporting
}: GenerationCompletedBubbleProps): ReactElement {
  return (
    <>
      <div className="wb-gen-result wb-gen-result--done">
        <ResultOrb tone="done">
          <Check />
        </ResultOrb>
        <div className="wb-gen-result__copy">
          <span className="wb-gen-result__eyebrow">生成结果</span>
          <strong>已提交</strong>
          <span>当前场景已写入作品。</span>
        </div>
        <button className="wb-gen-result__link" onClick={onOpenWorks} type="button">
          查看作品历史
          <ArrowRight />
        </button>
      </div>
      {cleanupPending ? (
        <div className="wb-gen-result__actions">
          <Button
            className="wb-gen-secondary"
            disabled={cleanupBusy || onRetryCleanup === undefined}
            onClick={onRetryCleanup}
            type="button"
          >
            <RefreshCw />
            {cleanupBusy ? '正在重试清理…' : '重试清理'}
          </Button>
          <span className="wb-gen-result__hint">
            {cleanupError ?? '作品已提交；清理只删除本次候选临时区，不会再次提交。'}
          </span>
        </div>
      ) : null}
      {startBlockedReason ? (
        <div className="wb-gen-result__blocked">
          <p className="wb-gen-result__hint">{startBlockedReason}</p>
          {startBlockedByGeneration && onOpenHistory ? (
            <button className="wb-gen-result__link" onClick={onOpenHistory} type="button">
              去 AI 历史处理
              <ArrowRight />
            </button>
          ) : null}
        </div>
      ) : null}
      <div className="wb-gen-result__actions wb-gen-result__actions--completed">
        <Button
          className="wb-gen-primary"
          disabled={pending || startBlockedReason !== null}
          data-guide-target="generation-start"
          onClick={onStart}
          type="button"
        >
          <Sparkles />
          {pending ? '正在准备生成…' : '按画布重新生成'}
        </Button>
        {onExport ? (
          <Button
            className="wb-gen-secondary"
            disabled={exporting === true || exportDisabled === true}
            data-guide-target="export-open"
            onClick={onExport}
            title={exportHint}
            type="button"
          >
            <Package />
            {exporting === true ? '正在导出…' : '导出当前场景'}
          </Button>
        ) : null}
      </div>
      <p className="wb-gen-result__hint">重新生成不会沿用上一候选。</p>
    </>
  )
}

interface GenerationStartRetryProps {
  pending: boolean
  startBlockedReason: string | null
  workspaceNotReady: boolean
  onStart: () => void
}

export function GenerationStartRetry({
  pending,
  startBlockedReason,
  workspaceNotReady,
  onStart
}: GenerationStartRetryProps): ReactElement {
  return (
    <Button
      className="wb-gen-quiet"
      disabled={pending || startBlockedReason !== null || workspaceNotReady}
      data-guide-target="generation-start"
      onClick={onStart}
      type="button"
    >
      <RefreshCw />
      重试生成
    </Button>
  )
}

export function GenerationConversation({
  status,
  cards,
  progress,
  draft,
  pending,
  pendingAction,
  actionError,
  loading,
  loadError,
  projectName,
  sceneLabel,
  startBlockedReason,
  startBlockedByGeneration,
  repairBlockedReason,
  startPhase,
  reviseOpen,
  exportDisabled,
  exportHint,
  exporting,
  onExport,
  onStart,
  onOpenSummary,
  onOpenHistory,
  onReturnToCanvas,
  onReload,
  onResume,
  onVerifyResult,
  onRetryCleanup,
  onRetryRepair,
  onCancel,
  onOpenWorks,
  onOpenRevise,
  onSelectOption,
  onSelectAnswer,
  onAnswerBodyChange,
  onBodyChange,
  onSubmitPrimary,
  onAccept,
  onDiscard
}: GenerationConversationProps): ReactElement {
  const candidateTab = useCandidatePreviewTab()
  const startFailure = actionError && actionError.kind === 'start' ? actionError : null
  const replyFailure = actionError && actionError.kind === 'reply' ? actionError : null
  const retryFailure = actionError && actionError.kind === 'retryRepair' ? actionError : null
  const verifyFailure = actionError && actionError.kind === 'verifyResult' ? actionError : null
  const view = status ? generationRunViewOf(status, progress) : null
  const activeInteraction = view?.interaction ?? null
  const activePhase = view?.phase ?? 'empty'
  const showRunStrip =
    activePhase === 'preparing' ||
    activePhase === 'running' ||
    activePhase === 'committing' ||
    activePhase === 'cancelling'
  const pendingStart = pending && pendingAction === 'start'
  const newSessionAttempt = pendingStart || (startFailure !== null && !showRunStrip)
  const outcomePhase =
    activePhase === 'failed' || activePhase === 'cancelled' || activePhase === 'paused'
      ? activePhase
      : null
  const viewPreviousCandidate =
    view?.candidate.previous === true && candidateTab?.available === true
      ? () => candidateTab.activate()
      : undefined

  return (
    <Conversation className="wb-gen-conversation">
      {status === null || view === null ? (
        <EmptyGeneration
          blockedReason={startBlockedReason}
          cards={cards}
          failure={startFailure}
          loadError={loadError}
          loading={loading}
          onOpenHistory={onOpenHistory}
          onOpenSummary={onOpenSummary}
          onReload={onReload}
          onStart={onStart}
          pending={pending}
          projectName={projectName}
          sceneLabel={sceneLabel}
          startPhase={startPhase}
        />
      ) : (
        <ConversationContent className="wb-gen-conversation__content">
          <UserBubble>按已保存编排生成本场景。</UserBubble>

          {startFailure !== null ? (
            <>
              <p className="wb-gen-outcome__error" role="alert">
                <CircleAlert />
                {startFailure.message}
              </p>
              <div className="wb-gen-result__actions">
                <GenerationStartRetry
                  onStart={onStart}
                  pending={pending}
                  startBlockedReason={startBlockedReason}
                  workspaceNotReady={startFailure.workspaceNotReady === true}
                />
                {startBlockedByGeneration && onOpenHistory ? (
                  <button className="wb-gen-result__link" onClick={onOpenHistory} type="button">
                    去 AI 历史处理
                    <ArrowRight />
                  </button>
                ) : null}
              </div>
            </>
          ) : null}

          {!newSessionAttempt
            ? status.answeredQuestions?.map((answer) => (
                <div className="wb-gen-answered" key={answer.questionId}>
                  <AssistantBubble>
                    <p className="wb-gen-answered__prompt">{answer.prompt}</p>
                  </AssistantBubble>
                  <UserBubble>
                    <p className="wb-gen-answered__choice">{answer.label}</p>
                    <p className="wb-gen-answered__detail">{answer.description}</p>
                    {answer.body ? <p className="wb-gen-answered__body">{answer.body}</p> : null}
                  </UserBubble>
                </div>
              ))
            : null}

          {!newSessionAttempt
            ? status.userMessages?.map((message) => (
                <UserBubble
                  key={`${message.kind}:${message.round}`}
                  meta={`${userMessageLabelOf(message)} · 只读`}
                  readOnly
                >
                  <p className="wb-gen-user-message">{message.body}</p>
                </UserBubble>
              ))
            : null}

          {showRunStrip ? (
            <AssistantBubble tone="wide">
              <GenerationRunStrip view={view} />
            </AssistantBubble>
          ) : null}

          {pendingStart ? (
            <AssistantBubble tone="wide">
              <p className="wb-gen-result__lead" role="status">
                <Clock3 />
                正在准备生成…
              </p>
            </AssistantBubble>
          ) : null}

          {activeInteraction !== null && activePhase === 'waiting' ? (
            <AssistantBubble tone="wide">
              <GenerationRunStrip view={view} />
              <GenerationInteraction
                draft={draft}
                error={replyFailure?.message ?? null}
                interaction={activeInteraction}
                onAccept={onAccept}
                onBodyChange={onBodyChange}
                onDiscard={onDiscard}
                onOpenRevise={onOpenRevise}
                onSelectOption={onSelectOption}
                onSelectAnswer={onSelectAnswer}
                onAnswerBodyChange={onAnswerBodyChange}
                onSubmitPrimary={onSubmitPrimary}
                pending={pending}
                reviseOpen={reviseOpen}
                status={status}
              />
            </AssistantBubble>
          ) : null}

          {activePhase === 'completed' && !newSessionAttempt ? (
            <AssistantBubble>
              <GenerationCompletedBubble
                cleanupBusy={pendingAction === 'retryCleanup'}
                cleanupError={
                  actionError?.kind === 'retryCleanup'
                    ? actionError.message
                    : (status.failure?.message ?? null)
                }
                cleanupPending={status.cleanupPending === true}
                onRetryCleanup={onRetryCleanup}
                exportDisabled={exportDisabled}
                exportHint={exportHint}
                exporting={exporting}
                onExport={onExport}
                onOpenWorks={onOpenWorks}
                onOpenHistory={onOpenHistory}
                onStart={onStart}
                pending={pending}
                startBlockedByGeneration={startBlockedByGeneration}
                startBlockedReason={startBlockedReason}
              />
            </AssistantBubble>
          ) : null}

          {outcomePhase !== null && !newSessionAttempt ? (
            <AssistantBubble outcome={outcomePhase} tone="wide">
              <GenerationOutcomeBubble
                key={`${status.operationId}:${activePhase}`}
                onCancel={onCancel}
                onOpenSummary={onOpenSummary}
                onRegenerate={onStart}
                onReload={onReload}
                onResume={onResume}
                onVerifyResult={onVerifyResult}
                onRetryRepair={onRetryRepair}
                onReturnToCanvas={onReturnToCanvas}
                onViewPreviousCandidate={viewPreviousCandidate}
                pending={pending}
                pendingAction={pendingAction}
                repairBlockedReason={repairBlockedReason}
                retryError={retryFailure?.message ?? null}
                startBlockedByGeneration={startBlockedByGeneration}
                startBlockedReason={startBlockedReason}
                onOpenHistory={onOpenHistory}
                status={status}
                verifyMessage={verifyFailure?.message ?? null}
                view={view}
              />
            </AssistantBubble>
          ) : null}

          {activePhase === 'cancelling' ? (
            <AssistantBubble>
              <p className="wb-gen-result__lead">
                <Clock3 />
                正在取消：先核对提交结果，再结束这次运行。
              </p>
            </AssistantBubble>
          ) : null}
        </ConversationContent>
      )}
      <ConversationScrollButton aria-label="回到最新位置" className="wb-gen-scroll" />
    </Conversation>
  )
}
