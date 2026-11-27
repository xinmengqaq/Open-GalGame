import { ArrowUp, CircleAlert, Pause, Play, X } from 'lucide-react'
import { useEffect, useRef, useState, type ReactElement, type ReactNode } from 'react'
import { toast } from 'sonner'

import type { SceneGenerationRenderStatusVO } from '@application/scene-generation/vo/SceneGenerationRenderVO'
import {
  PromptInput,
  PromptInputFooter,
  PromptInputSubmit,
  PromptInputTextarea
} from '@presentation/components/ai-elements/prompt-input'
import { Button } from '@presentation/components/ui/button'
import type { SessionCard } from '@presentation/features/workbench-session/workbenchSession.types'
import { CountUp } from '../CountUp'
import { GenerationConversation } from './GenerationConversation'
import { GenerationDialog, type GenerationDialogKind } from './GenerationDialogs'
import { GenerationInputSummaryBar } from './GenerationInputSummary'
import {
  canRevise,
  headerStatusPillOf,
  interactionIsLive,
  isTerminalState,
  tokenViewOf,
  type GenerationActionFailure
} from './generationPresentation'
import type { SceneGenerationController } from './useSceneGeneration'
import { useGenerationMotion } from './useGenerationMotion'
import './generation.base.css'
import './generation.progress.css'
import './generation.interaction.css'
import './generation.empty.css'
import './generation.summary.css'
import './generation.effects.css'

interface GenerationHeaderProps {
  projectName: string
  sceneLabel: string
  status: SceneGenerationRenderStatusVO | null
  pendingStart?: boolean
  startFailure?: GenerationActionFailure | null
}

export function GenerationHeader({
  projectName,
  sceneLabel,
  status,
  pendingStart = false,
  startFailure = null
}: GenerationHeaderProps): ReactElement {
  const newSessionAttempt =
    pendingStart || (startFailure !== null && (status === null || isTerminalState(status.state)))
  const pill = headerStatusPillOf(status, { pendingStart, startFailure })
  const tokens = status !== null && !newSessionAttempt ? tokenViewOf(status.usage) : null
  return (
    <div className="wb-gen-header">
      <div className="wb-gen-header__title">
        <h1 className="wb-gen-header__name">{projectName}</h1>
        <p className="wb-gen-header__subline">
          <span className="wb-gen-header__scene">{sceneLabel}</span>
          <span aria-hidden="true" className="wb-gen-header__dot" />
          <span className="wb-gen-pill" data-tone={pill.tone}>
            <i aria-hidden="true" />
            {pill.label}
          </span>
        </p>
      </div>
      {status && tokens ? (
        <div aria-label="当前操作累计 Token" className="wb-gen-tokens">
          <div className="wb-gen-tokens__cell">
            <span>输入</span>
            <strong>
              <CountUp value={status.usage.inputTokens} />
            </strong>
          </div>
          <div className="wb-gen-tokens__cell">
            <span>输出</span>
            <strong>
              <CountUp value={status.usage.outputTokens} />
            </strong>
          </div>
          <div className="wb-gen-tokens__cell wb-gen-tokens__cell--total">
            <span>总计</span>
            <strong>
              <CountUp value={status.usage.totalTokens} />
            </strong>
          </div>
          {tokens.limitLabel === null ? null : (
            <div className="wb-gen-tokens__limit">{tokens.limitLabel}</div>
          )}
        </div>
      ) : (
        <div className="wb-gen-tokens wb-gen-tokens--idle">
          <span>尚未开始生成</span>
        </div>
      )}
    </div>
  )
}

interface GenerationPanelProps {
  controller: SceneGenerationController
  projectName: string
  sceneLabel: string
  cards: readonly SessionCard[]
  onOpenWorks: () => void
  onOpenSummary?: () => void
  onOpenHistory?: () => void
  onReturnToCanvas?: () => void
  onExport?: () => void
  exportDisabled?: boolean
  exportHint?: string
  exporting?: boolean
}

export function GenerationPanel({
  controller,
  projectName,
  sceneLabel,
  cards,
  onOpenWorks,
  onOpenSummary,
  onOpenHistory,
  onReturnToCanvas,
  onExport,
  exportDisabled,
  exportHint,
  exporting
}: GenerationPanelProps): ReactElement {
  const {
    status,
    phase,
    loading,
    loadError,
    pending,
    startPhase,
    actionError,
    draft,
    progress,
    progressNotice,
    selectionNotice,
    startBlockedReason,
    startBlockedByGeneration,
    repairBlockedReason,
    start,
    submitPrimary,
    accept,
    discard,
    pause,
    resume,
    resumeUnfinished,
    retryCleanup,
    verifyResult,
    cancel,
    retryRepair,
    selectOption,
    selectAnswer,
    setAnswerBody,
    setBody,
    reload
  } = controller

  const [summaryOpen, setSummaryOpen] = useState(false)
  const [reviseFor, setReviseFor] = useState<string | null>(null)
  const [dialog, setDialog] = useState<GenerationDialogKind | null>(null)
  const [pauseMarker, setPauseMarker] = useState<string | null>(null)
  const root = useRef<HTMLDivElement>(null)
  const interaction = status?.interaction ?? null
  const interactionId = interaction?.interactionId ?? null
  const reviseOpen = reviseFor !== null && reviseFor === interactionId

  useGenerationMotion(root, { phase, view: 'current', interactionId })

  useEffect(() => {
    if (progressNotice === null) return
    toast(progressNotice, { id: 'generation-progress-notice' })
  }, [progressNotice])

  /* 显式选择的记录被后端确认不存在时明确告知；不静默改看别的任务。 */
  useEffect(() => {
    if (selectionNotice === null) return
    toast(selectionNotice, { id: 'generation-selection-notice', duration: 8000 })
  }, [selectionNotice])

  /* 空态已有内联错误；当前视图仍显示旧状态时，重载失败也要可见。 */
  const hasVisibleStatus = status !== null
  useEffect(() => {
    if (loadError === null || !hasVisibleStatus) return
    toast.error(loadError, { id: 'generation-reload-error' })
  }, [hasVisibleStatus, loadError])

  const pauseAwaiting =
    pauseMarker !== null &&
    status !== null &&
    status.operationId === pauseMarker &&
    status.stage !== 'paused' &&
    !isTerminalState(status.state) &&
    actionError?.kind !== 'pause'
  const pauseBusy = pending === 'pause' || pauseAwaiting
  const composerVisible =
    status !== null &&
    interaction !== null &&
    interactionIsLive(status, interaction.interactionId) &&
    canRevise(interaction) &&
    (interaction.kind === 'correction' || reviseOpen)
  const composerBusy = pending === 'reply'
  const cancelVisible =
    status !== null &&
    status.canCancel &&
    (phase === 'running' || phase === 'preparing' || phase === 'waiting')
  const waitingCancelVisible = cancelVisible && phase === 'waiting' && pending === null
  const startFailure = actionError && actionError.kind === 'start' ? actionError : null
  const requestFailure =
    actionError && actionError.kind !== 'start' && actionError.kind !== 'reply'
      ? actionError.message
      : null

  const handlePause = (): void => {
    setPauseMarker(status?.operationId ?? null)
    void pause()
  }

  const requestCancel = (): void => {
    setDialog('cancel')
  }

  const requestDiscard = (): void => {
    setDialog('discard')
  }

  let dock: ReactNode = null
  if (phase === 'running' || phase === 'preparing') {
    dock = (
      <div className="wb-gen-dock">
        <p className="wb-gen-dock__hint">
          <strong>{phase === 'preparing' ? '正在准备。' : '正在生成。'}</strong>
          关闭抽屉不会取消任务。
        </p>
        {status?.canResumeUnfinished ? (
          <Button
            className="wb-gen-primary"
            disabled={pending !== null}
            onClick={() => void resumeUnfinished()}
            type="button"
          >
            {pending === 'resumeUnfinished' ? <span className="wb-gen-spinner" /> : <Play />}
            {pending === 'resumeUnfinished' ? '正在继续…' : '继续未完成的生成'}
          </Button>
        ) : null}
        {status?.canPause ? (
          <Button
            className="wb-gen-secondary"
            disabled={pauseBusy}
            onClick={handlePause}
            type="button"
          >
            {pauseBusy ? <span className="wb-gen-spinner" /> : <Pause />}
            {pauseBusy ? '正在暂停' : '暂停生成'}
          </Button>
        ) : null}
        {cancelVisible ? (
          <Button className="wb-gen-quiet" onClick={requestCancel} type="button">
            <X />
            取消
          </Button>
        ) : null}
      </div>
    )
  } else if (phase === 'committing' || phase === 'cancelling') {
    dock = (
      <div className="wb-gen-dock">
        <p className="wb-gen-dock__hint">
          <strong>{phase === 'committing' ? '正在提交。' : '正在取消。'}</strong>
          {phase === 'committing'
            ? '提交期间不能暂停或取消，完成前不会显示成功。'
            : '先核对提交结果，再结束这次运行。'}
        </p>
        {phase === 'cancelling' && status?.canCancel ? (
          <Button className="wb-gen-quiet" onClick={requestCancel} type="button">
            <X />
            结束本次生成
          </Button>
        ) : null}
      </div>
    )
  }

  return (
    <div className="wb-gen-panel" ref={root}>
      <div className="wb-gen-current">
        <div className="wb-gen-head">
          <GenerationHeader
            pendingStart={pending === 'start'}
            projectName={projectName}
            sceneLabel={sceneLabel}
            startFailure={startFailure}
            status={status}
          />
        </div>
        <div className="wb-gen-stage">
          <GenerationConversation
            actionError={actionError}
            cards={cards}
            draft={draft}
            exportDisabled={exportDisabled}
            exportHint={exportHint}
            exporting={exporting}
            loadError={loadError}
            loading={loading}
            onAccept={() => void accept()}
            onAnswerBodyChange={setAnswerBody}
            onBodyChange={setBody}
            onCancel={requestCancel}
            onDiscard={requestDiscard}
            onExport={onExport}
            onOpenHistory={onOpenHistory}
            onOpenRevise={() => setReviseFor(interactionId)}
            onOpenSummary={onOpenSummary}
            onOpenWorks={onOpenWorks}
            onReload={reload}
            onResume={() => {
              setPauseMarker(null)
              void resume()
            }}
            onVerifyResult={() => void verifyResult()}
            onRetryCleanup={() => void retryCleanup()}
            onRetryRepair={() => void retryRepair()}
            onReturnToCanvas={onReturnToCanvas}
            onSelectAnswer={selectAnswer}
            onSelectOption={selectOption}
            onSubmitPrimary={() => void submitPrimary()}
            onStart={() => void start()}
            pending={pending !== null}
            pendingAction={pending}
            progress={progress}
            projectName={projectName}
            reviseOpen={reviseOpen}
            sceneLabel={sceneLabel}
            repairBlockedReason={repairBlockedReason}
            startBlockedByGeneration={startBlockedByGeneration}
            startBlockedReason={startBlockedReason}
            startPhase={startPhase}
            status={status}
          />
        </div>

        {status !== null ? (
          <GenerationInputSummaryBar
            cards={cards}
            onOpenChange={setSummaryOpen}
            onOpenFullSummary={onOpenSummary}
            open={summaryOpen}
            status={status}
          />
        ) : null}

        {composerVisible && interaction ? (
          <div className="wb-gen-dock wb-gen-dock--composer">
            <div className="wb-gen-composer__head">
              <span className="wb-gen-composer__label">修改要求</span>
              <span className="wb-gen-composer__meta">新操作 · 失败时保留草稿</span>
            </div>
            <PromptInput
              className="wb-gen-composer"
              key={`${interaction.interactionId}:${actionError?.message ?? ''}`}
              onSubmit={() => void submitPrimary()}
            >
              <PromptInputTextarea
                aria-label="修改要求"
                disabled={composerBusy}
                maxLength={2000}
                onChange={(event) => setBody(event.currentTarget.value)}
                placeholder="描述你想改哪里，例如：先让角色看到伞，再抬头……"
                value={draft.body}
              />
              <PromptInputFooter>
                <span className="wb-gen-dock__hint">
                  {requestFailure ? (
                    <span className="wb-gen-dock__failure" role="alert">
                      <CircleAlert />
                      {requestFailure}
                    </span>
                  ) : (
                    '修改会开启新一轮生成，失败时保留草稿。'
                  )}
                </span>
                <PromptInputSubmit
                  aria-label={composerBusy ? '正在提交修改' : '提交修改'}
                  className="wb-gen-composer__submit"
                  disabled={composerBusy || draft.body.trim().length === 0}
                  size="sm"
                >
                  {composerBusy ? (
                    <span className="wb-gen-spinner" />
                  ) : (
                    <>
                      <span>提交修改</span>
                      <ArrowUp />
                    </>
                  )}
                </PromptInputSubmit>
              </PromptInputFooter>
            </PromptInput>
          </div>
        ) : (
          dock
        )}

        {waitingCancelVisible ? (
          <div className="wb-gen-dock wb-gen-dock--waiting">
            <p className="wb-gen-dock__hint">
              <strong>等待你的回复。</strong>
              取消会先核对提交结果，再结束这次生成。
            </p>
            <Button className="wb-gen-quiet" onClick={requestCancel} type="button">
              <X />
              取消本次生成
            </Button>
          </div>
        ) : null}
      </div>

      <GenerationDialog
        failure={dialog === 'discard' ? requestFailure : null}
        kind={dialog}
        onConfirm={() => {
          const action = dialog
          setDialog(null)
          if (action === 'cancel') void cancel()
          if (action === 'discard') void discard()
        }}
        onOpenChange={(open) => {
          if (!open) setDialog(null)
        }}
        pending={pending === 'cancel' || pending === 'reply'}
      />
    </div>
  )
}
