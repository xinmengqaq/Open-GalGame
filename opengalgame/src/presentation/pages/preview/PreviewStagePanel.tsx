import { clsx } from 'clsx'
import {
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  Info,
  LoaderCircle,
  LocateFixed,
  MonitorPlay,
  RefreshCw,
  RotateCcw
} from 'lucide-react'
import type { ReactElement } from 'react'

import type {
  PreviewPhase,
  PreviewPositionVO
} from '@application/scene-preview/vo/PreviewRuntimeVO'
import type { SceneDialogueVO } from '@application/scene-preview/vo/ScenePreviewSessionVO'

import { GameStageFrame } from '@presentation/features/game-stage/GameStageFrame'
import { GameStageLoading } from '@presentation/features/game-stage/GameStageLoading'
import { GameStageStatePanel } from '@presentation/features/game-stage/GameStageStatePanel'

import {
  dialogueNumber,
  phaseStatusOf,
  positionTextOf,
  prepareFailureAction,
  previewCopy,
  selectFailureAction,
  type PreviewFailureView
} from './previewPresentation'
import styles from './PreviewStagePanel.module.css'
import type { PreviewStageUiState, PreviewUpdateNotice } from './useScenePreviewStage'

interface PreviewStagePanelProps {
  readonly stage: PreviewStageUiState
  readonly phase: PreviewPhase
  readonly position: PreviewPositionVO
  readonly dialogues: readonly SceneDialogueVO[]
  readonly dirtyCount: number
  readonly stageBusy: boolean
  readonly iframeLoaded: boolean
  readonly startupPending: boolean
  readonly frameToken: number
  readonly controlsBlockedReason: string | null
  readonly canPrevious: boolean
  readonly canNext: boolean
  readonly followEnabled: boolean
  readonly locateFailure: PreviewFailureView | null
  readonly previewUpdateNotice: PreviewUpdateNotice | null
  readonly draftNotice: string | null
  readonly subscriptionNotice: string | null
  readonly onPrevious: () => void
  readonly onNext: () => void
  readonly onReplay: () => void
  readonly onToggleFollow: () => void
  readonly onStageLoad: () => void
  readonly onReloadFrame: () => void
  readonly onPrepareAgain: () => void
  readonly onRetryLocate: () => void
  readonly onRetrySavedLocate: () => void
  readonly onReopen: () => void
}

export function PreviewStagePanel({
  stage,
  phase,
  position,
  dialogues,
  dirtyCount,
  stageBusy,
  iframeLoaded,
  startupPending,
  frameToken,
  controlsBlockedReason,
  canPrevious,
  canNext,
  followEnabled,
  locateFailure,
  previewUpdateNotice,
  draftNotice,
  subscriptionNotice,
  onPrevious,
  onNext,
  onReplay,
  onToggleFollow,
  onStageLoad,
  onReloadFrame,
  onPrepareAgain,
  onRetryLocate,
  onRetrySavedLocate,
  onReopen
}: PreviewStagePanelProps): ReactElement {
  const failed = stage.status === 'failed'
  const preparing = stage.status === 'idle' || stage.status === 'preparing'
  const entering = stage.status === 'ready' && iframeLoaded && startupPending
  const iframeReady = stage.status === 'ready' && iframeLoaded && !startupPending
  const statusStage = failed ? 'failed' : iframeReady ? 'ready' : 'preparing'
  const status = phaseStatusOf({ stage: statusStage, phase, position })
  const statusClass =
    status.tone === 'error'
      ? styles.statusError
      : status.tone === 'busy'
        ? styles.statusBusy
        : status.tone === 'ok'
          ? styles.statusOk
          : styles.statusQuiet
  const numbered =
    position.kind === 'dialogue' ? dialogueNumber(dialogues, position.dialogueId) : null
  const positionText = failed || !iframeReady ? '—' : positionTextOf(position, dialogues)
  const progress =
    numbered === null ? 0 : Math.min(100, (numbered / Math.max(1, dialogues.length)) * 100)
  const prepareAction = failed ? prepareFailureAction(stage.failure) : 'none'
  const locateAction = locateFailure === null ? 'none' : selectFailureAction(locateFailure)
  const transportBlocked =
    !iframeReady || stageBusy || controlsBlockedReason !== null || preparing || failed
  const transportTitle = controlsBlockedReason ?? null
  const restoreTargetNumber =
    previewUpdateNotice?.dialogueId === null || previewUpdateNotice?.dialogueId === undefined
      ? null
      : dialogueNumber(dialogues, previewUpdateNotice.dialogueId)

  return (
    <section
      className={styles.panel}
      aria-label={previewCopy.stageTitle}
      data-testid="preview-stage-panel"
    >
      <header className={styles.head}>
        <div className={styles.headLeft}>
          <span className={styles.eyebrow}>{previewCopy.stageTitle}</span>
          {dirtyCount > 0 && iframeReady ? (
            <span className={styles.draftBadge}>草稿 · {dirtyCount} 处</span>
          ) : null}
        </div>
        <div className={styles.headRight}>
          <span className={clsx(styles.status, statusClass)}>
            <span className={styles.statusDot} aria-hidden="true" />
            {status.label}
          </span>
          <span className={styles.position}>{positionText}</span>
        </div>
      </header>

      <div className={styles.viewport}>
        <GameStageFrame
          className={styles.surface}
          src={stage.status === 'ready' ? stage.stageUrl : null}
          title="游戏舞台"
          status={failed ? 'failed' : iframeReady ? 'ready' : 'loading'}
          frameToken={frameToken}
          onStageLoad={onStageLoad}
        >
          {preparing ? (
            <GameStageLoading title="正在准备舞台" description="准备好后，真实画面会出现在这里。" />
          ) : null}
          {stage.status === 'ready' && !iframeLoaded ? (
            <GameStageLoading
              title="舞台画面正在载入"
              description="画面加载完成后会自动进入场景并定位到当前句。"
              action={
                <button type="button" className={styles.quietAction} onClick={onReloadFrame}>
                  <RefreshCw size={13} strokeWidth={1.9} />
                  重新载入画面
                </button>
              }
            />
          ) : null}
          {entering ? (
            <GameStageLoading
              title="正在进入游戏"
              description="正在处理语言和标题画面；进入场景后会定位到当前句。"
            />
          ) : null}
          {failed ? (
            <GameStageStatePanel
              surface="dark"
              accent="danger"
              role="alert"
              icon={<MonitorPlay size={24} strokeWidth={1.7} />}
              title="舞台没有准备成功"
              description={stage.failure.message}
              actions={
                prepareAction === 'none' ? undefined : (
                  <>
                    {prepareAction === 'prepare' ? (
                      <button
                        type="button"
                        className={styles.primaryAction}
                        onClick={onPrepareAgain}
                      >
                        <RefreshCw size={14} strokeWidth={1.9} />
                        重新准备
                      </button>
                    ) : null}
                    <button
                      type="button"
                      className={
                        prepareAction === 'prepare' ? styles.quietAction : styles.primaryAction
                      }
                      onClick={onReopen}
                    >
                      重新打开预览
                    </button>
                  </>
                )
              }
              note="左侧台词仍然可以查看；已保存的内容不会受影响。"
            />
          ) : null}
          {iframeReady && position.kind === 'unknown' ? (
            <span className={styles.positionPill}>位置待确认</span>
          ) : null}
          {stageBusy && iframeReady ? (
            <span className={styles.busyMark} role="status">
              <LoaderCircle size={13} strokeWidth={2} className={styles.spin} />
              正在定位…
            </span>
          ) : null}
        </GameStageFrame>
      </div>

      <div className={styles.controls}>
        <div className={styles.stepGroup}>
          <button
            type="button"
            className={styles.stepButton}
            onClick={onReplay}
            disabled={transportBlocked}
            aria-label="重播本场"
            title={transportTitle ?? (iframeReady ? '从第一句重新定位' : '舞台就绪后可以重播')}
          >
            <RotateCcw size={15} strokeWidth={2} />
            重播
          </button>
          <button
            type="button"
            className={styles.stepButton}
            onClick={onPrevious}
            disabled={transportBlocked || !canPrevious}
            aria-label="上一句"
            title={transportTitle ?? (canPrevious ? '上一句' : '舞台位置未确认或已到第一句')}
          >
            <ChevronLeft size={16} strokeWidth={2} />
            上一句
          </button>
          <button
            type="button"
            className={styles.stepButton}
            onClick={onNext}
            disabled={transportBlocked || !canNext}
            aria-label="下一句"
            title={transportTitle ?? (canNext ? '下一句' : '舞台位置未确认或已到最后一句')}
          >
            下一句
            <ChevronRight size={16} strokeWidth={2} />
          </button>
        </div>

        <div className={styles.progress} aria-hidden="true">
          <span className={styles.progressIndex}>{numbered === null ? '—' : numbered}</span>
          <span className={styles.track}>
            <span className={styles.trackFill} style={{ width: `${progress}%` }} />
          </span>
          <span className={styles.progressTotal}>{dialogues.length}</span>
        </div>

        <button
          type="button"
          className={clsx(styles.followButton, followEnabled && styles.followButtonOn)}
          onClick={onToggleFollow}
          disabled={!iframeReady || (position.kind !== 'dialogue' && !followEnabled)}
          aria-pressed={followEnabled}
          title={
            !iframeReady
              ? '舞台没有载入，暂时不能跟随'
              : position.kind !== 'dialogue' && !followEnabled
                ? '舞台位置确认后可以跟随'
                : followEnabled
                  ? '停止跟随舞台位置'
                  : '回到舞台当前位置'
          }
        >
          <LocateFixed size={14} strokeWidth={2} />
          {followEnabled ? '跟随定位' : '恢复跟随'}
        </button>
      </div>

      {locateFailure !== null ||
      previewUpdateNotice !== null ||
      draftNotice !== null ||
      subscriptionNotice !== null ? (
        <div className={styles.notices}>
          {locateFailure !== null ? (
            <div className={styles.notice} data-tone="error" role="alert">
              <CircleAlert size={15} strokeWidth={1.9} />
              <span>{locateFailure.message}</span>
              {locateAction === 'locate' ? (
                <button type="button" className={styles.noticeAction} onClick={onRetryLocate}>
                  重试定位
                </button>
              ) : null}
              {locateAction === 'reopen' ? (
                <button type="button" className={styles.noticeAction} onClick={onReopen}>
                  重新打开预览
                </button>
              ) : null}
            </div>
          ) : null}

          {previewUpdateNotice !== null ? (
            <div className={styles.notice} data-tone={previewUpdateNotice.tone} role="status">
              <Info size={15} strokeWidth={1.9} />
              <span>{previewUpdateNotice.message}</span>
              {previewUpdateNotice.action === 'retryLocate' ? (
                <button type="button" className={styles.noticeAction} onClick={onRetrySavedLocate}>
                  {restoreTargetNumber === null ? '重新定位' : `回到第 ${restoreTargetNumber} 句`}
                </button>
              ) : null}
              {previewUpdateNotice.action === 'reopen' ? (
                <button type="button" className={styles.noticeAction} onClick={onReopen}>
                  重新打开预览
                </button>
              ) : null}
            </div>
          ) : null}

          {draftNotice !== null ? (
            <div className={styles.notice} data-tone="quiet" role="status">
              <Info size={15} strokeWidth={1.9} />
              <span>{draftNotice}</span>
            </div>
          ) : null}

          {subscriptionNotice !== null ? (
            <div className={styles.notice} data-tone="quiet" role="status">
              <Info size={15} strokeWidth={1.9} />
              <span>{subscriptionNotice}</span>
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  )
}
