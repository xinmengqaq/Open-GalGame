import {
  ArrowRight,
  Check,
  ChevronDown,
  CircleAlert,
  Clock3,
  Gamepad2,
  Layers,
  LockKeyhole,
  Package,
  Play,
  RefreshCw,
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
import { useCandidatePreviewTab } from '../candidate/candidatePreviewContext'
import { SceneArt } from './SceneArt'
import { GenerationInteraction } from './GenerationInteraction'
import { GenerationRunDetails, GenerationRunStrip } from './GenerationRunDetails'
import {
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
  startPhase: 'saving' | 'preparing' | null
  reviseOpen: boolean
  /** 导出入口由工作台页面接入；旧对话流不传时隐藏按钮。 */
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

function EmptyGeneration({
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
          <p>
            让 AI
            先按已保存的编排把这一场写出来，再一起决定需要你拍板的地方。打开抽屉不会自动开始生成。
          </p>
        </div>

        <div className="wb-gen-empty__actions" data-gen-motion="actions">
          <button
            className="wb-gen-empty__primary"
            disabled={pending || blockedReason !== null || workspaceNotReady}
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
              <button className="wb-gen-empty__link" onClick={onOpenSummary} type="button">
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

/**
 * 已确认的候选问题只显示应用层固定文案，不显示原始诊断或路径。
 */
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

/**
 * “重试本次修改”的确认区：明确展示将携带的修改正文、上一候选的只读边界
 * 和输入来源，再发新操作；不会改写原失败记录。
 */
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

/** 诊断折叠只显示故障指纹和操作时间；缺失时明确写没有编号，不补造。 */
function FailureDiagnostics({
  failure
}: {
  failure: NonNullable<GenerationRunView['failure']>
}): ReactElement {
  return (
    <details className="wb-gen-outcome__diagnostics">
      <summary>
        <span>诊断信息</span>
        <ChevronDown aria-hidden="true" />
      </summary>
      <dl>
        <div>
          <dt>故障指纹</dt>
          <dd>{failure.reference ?? '没有可用的诊断编号'}</dd>
        </div>
        <div>
          <dt>操作时间</dt>
          <dd>
            {failure.recordedAt ? historySecondTime(failure.recordedAt) : '没有可用的操作时间'}
          </dd>
        </div>
      </dl>
    </details>
  )
}

interface GenerationOutcomeBubbleProps {
  view: GenerationRunView
  status: SceneGenerationRenderStatusVO
  pending: boolean
  pendingAction: GenerationActionKind | null
  startBlockedReason: string | null
  retryError: string | null
  onResume?: () => void
  onCancel?: () => void
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
      return <Play />
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
  if (action === 'cancel' && pendingAction === 'cancel') return '正在取消…'
  if (action === 'retry-repair' && pendingAction === 'retryRepair') return '正在重试本次修改…'
  if (action === 'regenerate' && pendingAction === 'start') return '正在准备生成…'
  return label
}

/**
 * 暂停、失败和取消共用同一状态气泡：状态标记 → 标题 → 原因 → 下一步 →
 * 真实可用动作 → 诊断。动作集合来自运行投影，不直接渲染后端 nextActions。
 */
export function GenerationOutcomeBubble({
  view,
  status,
  pending,
  pendingAction,
  startBlockedReason,
  retryError,
  onResume,
  onCancel,
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
      {nextStep ? (
        <div className="wb-gen-outcome__next">
          <span>下一步</span>
          <p>{nextStep}</p>
        </div>
      ) : null}

      <KnownIssueList issues={status.knownIssues} />
      {view.candidate.previousNote ? (
        <p className="wb-gen-outcome__note">{view.candidate.previousNote}</p>
      ) : null}
      {startBlockedReason && phase !== 'paused' ? (
        <p className="wb-gen-outcome__blocker">{startBlockedReason}</p>
      ) : null}

      {retryConfirm && retry?.eligible ? (
        <RetryRepairConfirm
          blockedReason={startBlockedReason}
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
        {phase === 'failed' && failure ? <FailureDiagnostics failure={failure} /> : null}
      </div>
    </div>
  )
}

interface GenerationCompletedBubbleProps {
  pending: boolean
  startBlockedReason: string | null
  onStart: () => void
  onOpenWorks: () => void
  onExport?: () => void
  exportDisabled?: boolean
  exportHint?: string
  exporting?: boolean
}

/**
 * 「已提交」终态气泡：保留作品历史入口，并给一个按当前画布重新生成、
 * 启动全新操作的新入口；不沿用上一候选，也不覆盖旧记录。
 */
export function GenerationCompletedBubble({
  pending,
  startBlockedReason,
  onStart,
  onOpenWorks,
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
          <strong>已提交</strong>
          <span>这一场已经写入作品，可以到作品历史查看。</span>
        </div>
        <button className="wb-gen-result__link" onClick={onOpenWorks} type="button">
          查看作品历史
          <ArrowRight />
        </button>
      </div>
      <div className="wb-gen-result__actions wb-gen-result__actions--completed">
        <Button
          className="wb-gen-primary"
          disabled={pending || startBlockedReason !== null}
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
            onClick={onExport}
            title={exportHint}
            type="button"
          >
            <Package />
            {exporting === true ? '正在导出…' : '导出当前场景'}
          </Button>
        ) : null}
        <span className="wb-gen-result__hint">重新读取已保存编排，不沿用上一候选。</span>
      </div>
    </>
  )
}

interface GenerationStartRetryProps {
  pending: boolean
  startBlockedReason: string | null
  workspaceNotReady: boolean
  onStart: () => void
}

/**
 * start 失败后，上一轮的「按画布重新生成」入口会随旧终态气泡一起收起；
 * 这里保留一个只依赖当前门控状态的重试入口，避免瞬时失败后只能刷新页面。
 * 重试仍调用 useSceneGeneration.start()，由其清空错误并重新进入 pending。
 */
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
      onClick={onStart}
      type="button"
    >
      <RefreshCw />
      重试生成
    </Button>
  )
}

/**
 * 当前生成的对话流。用户消息只有启动指令，助手气泡依次承载紧凑进度行、
 * 当前交互和终态结果；阶段轨只在运行详情浮层里出现。
 */
export function GenerationConversation({
  status,
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
  const view = status ? generationRunViewOf(status, progress) : null
  const activeInteraction = view?.interaction ?? null
  const activePhase = view?.phase ?? 'empty'
  const showRunStrip =
    activePhase === 'preparing' ||
    activePhase === 'running' ||
    activePhase === 'committing' ||
    activePhase === 'cancelling'
  // 「重新生成」即新会话：start() 成功前 status 还是上一轮终态；启动请求期间
  // 和启动失败后，上一轮回答、修改正文和终态结果都属于历史，不出现在新会话视图。
  // 新 status 到达（启动成功）后，actionError 已清空，门控自动解除并按新状态渲染。
  // 实时运行态（运行条可见）说明会话已经在跑，此时残留的 startFailure 不应把
  // 进行中的会话按新会话处理，否则会误收起运行条和本轮输入。
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

          {/* 文案与应用层 SceneGenerationStartConflict 的常量保持一致；分层边界不允许直接导入。 */}
          {startFailure !== null ? (
            <>
              <p className="wb-gen-outcome__error" role="alert">
                <CircleAlert />
                {startFailure.message}
              </p>
              {/* 旧终态气泡收起后不再渲染「按画布重新生成」；容器复用现有动作行类，不新增 CSS。 */}
              <div className="wb-gen-result__actions">
                <GenerationStartRetry
                  onStart={onStart}
                  pending={pending}
                  startBlockedReason={startBlockedReason}
                  workspaceNotReady={startFailure.workspaceNotReady === true}
                />
              </div>
            </>
          ) : null}

          {/* 用户已确认的决定和修改要求属于上一轮输入，排在本次运行进度之前，
              避免修正轮看起来像 AI 先回复、用户后提要求。新会话尝试期间不展示。 */}
          {!newSessionAttempt
            ? status.answeredQuestions?.map((answer) => (
                <div className="wb-gen-answered" key={answer.questionId}>
                  <AssistantBubble>
                    <p className="wb-gen-answered__prompt">{answer.prompt}</p>
                  </AssistantBubble>
                  <UserBubble>
                    <p className="wb-gen-answered__choice">{answer.label}</p>
                    <p className="wb-gen-answered__detail">{answer.description}</p>
                    {answer.body ? (
                      <p className="wb-gen-answered__body">{answer.body}</p>
                    ) : null}
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
                exportDisabled={exportDisabled}
                exportHint={exportHint}
                exporting={exporting}
                onExport={onExport}
                onOpenWorks={onOpenWorks}
                onStart={onStart}
                pending={pending}
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
                onRetryRepair={onRetryRepair}
                onReturnToCanvas={onReturnToCanvas}
                onViewPreviousCandidate={viewPreviousCandidate}
                pending={pending}
                pendingAction={pendingAction}
                retryError={retryFailure?.message ?? null}
                startBlockedReason={startBlockedReason}
                status={status}
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
