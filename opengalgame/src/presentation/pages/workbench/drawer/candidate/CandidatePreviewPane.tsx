import {
  ChevronDown,
  CircleAlert,
  FileWarning,
  Gamepad2,
  History,
  Info,
  LoaderCircle,
  LockKeyhole,
  MonitorOff,
  RefreshCw,
  RotateCcw,
  TimerOff,
  TriangleAlert,
  Volume2,
  X
} from 'lucide-react'
import { useEffect, useRef, useState, type ReactElement } from 'react'

import { GameStageFrame } from '@presentation/features/game-stage/GameStageFrame'
import { GameStageLoading } from '@presentation/features/game-stage/GameStageLoading'
import {
  GameStageStatePanel,
  type GameStageStateAccent
} from '@presentation/features/game-stage/GameStageStatePanel'

import { candidateShortId, type CandidatePreviewPhase } from './candidatePreviewState'
import type { CandidatePreviewController } from './useCandidatePreview'
import './candidate.css'

type PhaseTone = 'live' | 'ready' | 'warn' | 'danger' | 'muted'

const phaseCopy: Record<
  CandidatePreviewPhase,
  { readonly title: string; readonly description: string; readonly tone: PhaseTone }
> = {
  opening: {
    title: '正在打开游戏候选',
    description: '正在核对候选会话并启动游戏。',
    tone: 'live'
  },
  ready: {
    title: '游戏已就绪',
    description: '读取完成，可以对照游戏画面判断是否需要修改。',
    tone: 'ready'
  },
  'read-failed': {
    title: '游戏候选读取失败',
    description: '未能读取这个候选的场景内容。会话仍有效时可以直接重新读取。',
    tone: 'danger'
  },
  'stage-failed': {
    title: '游戏加载失败',
    description: '引擎没有加载这个游戏候选。已经读取的问题仍然可以查看。',
    tone: 'danger'
  },
  invalidated: {
    title: '此游戏候选已失效',
    description: '候选已经更新或会话被关闭，旧画面和问题已清空。重新打开候选可以继续查看。',
    tone: 'warn'
  },
  expired: {
    title: '游戏运行已过期',
    description: '游戏运行会话已关闭，候选内容和读取问题仍然保留。重新运行可以继续查看画面。',
    tone: 'warn'
  },
  failed: {
    title: '游戏候选暂时打不开',
    description: '没有建立可用的候选会话。可以重新打开候选再试。',
    tone: 'danger'
  },
  unsupported: {
    title: '当前环境不支持游戏预览',
    description: '浏览器走查不会载入引擎画面，也不会生成演示画面或示例问题。',
    tone: 'muted'
  }
}

function fallbackIconOf(phase: CandidatePreviewPhase): ReactElement {
  if (phase === 'read-failed') return <FileWarning />
  if (phase === 'expired') return <TimerOff />
  if (phase === 'invalidated') return <History />
  return <MonitorOff />
}

function fallbackAccentOf(phase: CandidatePreviewPhase): GameStageStateAccent {
  if (phase === 'read-failed' || phase === 'failed') return 'danger'
  if (phase === 'expired' || phase === 'invalidated') return 'warning'
  return 'muted'
}

function readLabelOf(
  phase: CandidatePreviewPhase,
  read: CandidatePreviewController['state']['read'],
  issueCount: number,
  openingStalled: boolean
): string | null {
  if (phase === 'opening') {
    if (openingStalled) return read === 'ready' ? '读取完成 · 画面仍未就绪' : '等待画面就绪'
    return read === 'ready' ? '读取完成，正在启动游戏' : '正在读取候选'
  }
  if (phase === 'expired') return issueCount > 0 ? '读取完成 · 候选内容保留' : null
  if (phase === 'stage-failed') {
    if (read === 'ready') return '读取完成 · 问题仍可查看'
    if (read === 'loading') return '正在读取候选'
    return null
  }
  if (phase === 'read-failed') return '读取失败'
  if (phase !== 'ready') return null
  if (read === 'loading') return '正在读取候选'
  if (read === 'ready') return '读取完成'
  return '读取失败'
}

/**
 * 生成抽屉审阅气泡内的只读游戏候选。画面只来自真实候选会话的嵌入地址；
 * `iframe` 的 `load` 事件不代表就绪，就绪必须等后端舞台事件。
 */
export function CandidatePreviewPane({
  controller
}: {
  controller: CandidatePreviewController
}): ReactElement | null {
  const { state, phase, reloadStage, reopen, retryRead } = controller
  const [issuesOpenSession, setIssuesOpenSession] = useState<string | null>(null)
  const [soundHintClosedSession, setSoundHintClosedSession] = useState<string | null>(null)
  const root = useRef<HTMLElement>(null)
  const issueCount = state.issues.length
  const soundHintVisible = phase === 'ready' && soundHintClosedSession !== state.sessionId
  const issuesAvailable =
    (phase === 'ready' || phase === 'stage-failed' || phase === 'opening' || phase === 'expired') &&
    issueCount > 0
  const issuesOpen = issuesAvailable && issuesOpenSession === state.sessionId

  useEffect(() => {
    if (!issuesOpen) return
    const closeIssues = (event: PointerEvent | KeyboardEvent): void => {
      if (event instanceof KeyboardEvent) {
        if (event.key === 'Escape') setIssuesOpenSession(null)
        return
      }
      const target = event.target
      if (target instanceof Node && root.current?.contains(target)) return
      setIssuesOpenSession(null)
    }
    document.addEventListener('pointerdown', closeIssues)
    document.addEventListener('keydown', closeIssues)
    return () => {
      document.removeEventListener('pointerdown', closeIssues)
      document.removeEventListener('keydown', closeIssues)
    }
  }, [issuesOpen])

  if (!phase) return null

  const copy =
    phase === 'opening' && state.openingStalled
      ? { ...phaseCopy.opening, title: '仍在打开游戏候选' }
      : phaseCopy[phase]
  // 15 秒后只改提示和动作，不改 phase：画面仍可能在真实准备，不能伪造失败。
  const openingStalled = phase === 'opening' && state.openingStalled
  const shortId = candidateShortId(state.candidateSnapshotId)
  const stageStatus = phase === 'ready' ? 'ready' : phase === 'opening' ? 'loading' : 'failed'
  const stageSrc = phase === 'opening' || phase === 'ready' ? state.stageUrl : null
  const stageFailureVisible = phase === 'stage-failed'
  const fallbackVisible =
    phase === 'read-failed' ||
    phase === 'invalidated' ||
    phase === 'expired' ||
    phase === 'failed' ||
    phase === 'unsupported'
  const readLabel = readLabelOf(phase, state.read, issueCount, openingStalled)
  const stageFailureDescription = state.stageFailureMessage ?? copy.description
  const fallbackDescription =
    phase === 'read-failed' && state.readMessage
      ? state.readMessage
      : phase === 'failed' && state.failureMessage
        ? state.failureMessage
        : copy.description

  return (
    <section aria-label="游戏候选预览" className="wb-candidate" data-phase={phase} ref={root}>
      <header className="wb-candidate__head">
        <span className="wb-candidate__label">
          <Gamepad2 aria-hidden="true" />
          游戏候选
        </span>
        <span className="wb-candidate__scene" title={state.sceneName ?? undefined}>
          {state.sceneName ?? (phase === 'opening' ? '正在读取场景' : '当前场景')}
        </span>
        <span className="wb-candidate__readonly" title="只读预览，不能编辑或保存">
          <LockKeyhole aria-hidden="true" />
          只读
        </span>
        {shortId ? (
          <code aria-label="游戏候选短标识" className="wb-candidate__short">
            {shortId}
          </code>
        ) : null}
      </header>

      <GameStageFrame
        frameToken={state.frameToken}
        src={stageSrc}
        status={stageStatus}
        title="游戏候选画面"
      >
        {phase === 'opening' ? (
          <GameStageLoading
            title={openingStalled ? '仍在启动游戏画面' : '正在启动游戏画面'}
            description={
              openingStalled
                ? '已经等待较久，画面还没有就绪。可以重新打开再试一次。'
                : '从候选入口开始，真实画面准备好后会自动显示。'
            }
          />
        ) : null}

        {stageFailureVisible ? (
          <GameStageStatePanel
            accent="danger"
            description={stageFailureDescription}
            icon={<MonitorOff />}
            role="alert"
            surface="dark"
            title="游戏没有启动"
          />
        ) : null}

        {fallbackVisible ? (
          <GameStageStatePanel
            accent={fallbackAccentOf(phase)}
            description={fallbackDescription}
            icon={fallbackIconOf(phase)}
            role={phase === 'read-failed' || phase === 'failed' ? 'alert' : 'status'}
            surface="paper"
            title={copy.title}
            {...(phase === 'unsupported'
              ? {
                  note: (
                    <>
                      <LockKeyhole aria-hidden="true" />
                      游戏候选不会在浏览器中载入引擎页面
                    </>
                  )
                }
              : {})}
          />
        ) : null}

        {issuesAvailable ? (
          <div
            aria-label="读取问题"
            className="wb-candidate__issues"
            data-open={issuesOpen}
            role="region"
          >
            <div className="wb-candidate__issues-head">
              <span>
                <TriangleAlert aria-hidden="true" />
                读取问题
              </span>
              <button
                aria-label="关闭读取问题"
                onClick={() => setIssuesOpenSession(null)}
                type="button"
              >
                <X aria-hidden="true" />
              </button>
            </div>
            <ul className="wb-candidate__issue-list">
              {state.issues.map((issue, index) => (
                <li className="wb-candidate__issue" key={`${issue.message}:${index}`}>
                  <span aria-hidden="true" className="wb-candidate__issue-icon">
                    <Info />
                  </span>
                  <span className="wb-candidate__issue-copy">
                    <span>{issue.message}</span>
                    {issue.assetName ? <small>素材 · {issue.assetName}</small> : null}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </GameStageFrame>

      {soundHintVisible ? (
        <p className="wb-candidate__sound" role="note">
          <Volume2 aria-hidden="true" />
          <span>画面已就绪。没听到音乐时，先点“重新载入画面”，再点画面里的“开始游戏”。</span>
          <button
            aria-label="关闭声音提示"
            onClick={() => setSoundHintClosedSession(state.sessionId)}
            type="button"
          >
            <X aria-hidden="true" />
          </button>
        </p>
      ) : null}

      <footer className="wb-candidate__bar">
        {/* 回退状态面板已经显示同一个标题；状态行只保留读取状态和真实动作，不重复标题。 */}
        {fallbackVisible ? null : (
          <span aria-live="polite" className="wb-candidate__phase" data-tone={copy.tone}>
            <i aria-hidden="true" />
            {copy.title}
          </span>
        )}
        {readLabel ? <span className="wb-candidate__read">{readLabel}</span> : null}
        {issuesAvailable ? (
          <button
            aria-expanded={issuesOpen}
            className="wb-candidate__issues-toggle"
            onClick={() => setIssuesOpenSession(issuesOpen ? null : state.sessionId)}
            type="button"
          >
            <CircleAlert aria-hidden="true" />
            {issueCount} 个读取问题
            <ChevronDown aria-hidden="true" data-open={issuesOpen} />
          </button>
        ) : null}

        <span className="wb-candidate__actions">
          {phase === 'read-failed' ? (
            <button className="wb-candidate__action" onClick={retryRead} type="button">
              <RefreshCw aria-hidden="true" />
              重新读取
            </button>
          ) : null}
          {phase === 'ready' ? (
            <>
              <button
                className="wb-candidate__action"
                disabled={state.read === 'loading'}
                onClick={retryRead}
                type="button"
              >
                <RefreshCw aria-hidden="true" />
                重新读取
              </button>
              <button
                className="wb-candidate__action"
                onClick={reloadStage}
                title="重新载入当前候选画面；不会改变候选或读取结果"
                type="button"
              >
                <RotateCcw aria-hidden="true" />
                重新载入画面
              </button>
            </>
          ) : null}
          {phase === 'stage-failed' ||
          phase === 'invalidated' ||
          phase === 'expired' ||
          phase === 'failed' ? (
            <button
              className="wb-candidate__action wb-candidate__action--primary"
              onClick={reopen}
              title={
                phase === 'stage-failed' || phase === 'expired'
                  ? '重新运行当前候选，不改变候选内容'
                  : '重新打开候选'
              }
              type="button"
            >
              <RotateCcw aria-hidden="true" />
              {phase === 'stage-failed' || phase === 'expired' ? '重新运行' : '重新打开候选'}
            </button>
          ) : null}
          {phase === 'opening' ? (
            openingStalled ? (
              <>
                <span className="wb-candidate__pending" data-stalled="true">
                  <TimerOff aria-hidden="true" />
                  等待较久
                </span>
                <button
                  className="wb-candidate__action wb-candidate__action--primary"
                  onClick={reopen}
                  title="重新打开当前候选，不改变候选内容"
                  type="button"
                >
                  <RotateCcw aria-hidden="true" />
                  重新打开
                </button>
              </>
            ) : (
              <span className="wb-candidate__pending">
                <LoaderCircle aria-hidden="true" />
                正在打开
              </span>
            )
          ) : null}
        </span>
      </footer>
    </section>
  )
}
