import { useEffect, useRef, useState, type ReactElement } from 'react'

import { GuideCopyText } from './GuideCopy'
import { useGuideMarkers } from './useGuideMarkers'
import type { GuideMediaAvailability } from './guideObservation'
import {
  guideImportAttemptKey,
  type GuideMediaImportAction,
  type GuideMediaImportOutcome
} from './guideMedia'
import { GuideButton } from './GuideButton'
import {
  guideArrangeViewOf,
  type GuideArrangeView,
  type GuidePrompt,
  type GuideSessionState
} from './advanceGuide'
import { canSkipGuideStep } from './guidePrompt'
import {
  GUIDE_ARRANGE_BACKGROUND_ACTION,
  GUIDE_FINISH_LABEL,
  GUIDE_STEP_ID,
  guideStepById,
  guideStepTotal,
  type GuideArrangeCardRole
} from './guideSteps'
import styles from './GuideStepOverlay.module.css'
import { useGuideOverlayMotion } from './useGuideMotion'
import { guideNavigationViewOf, type GuideNavigationView } from './guideNavigation'
import { useGuideDrag, type GuideOverlayLayout } from './guideDrag'

interface GuideStepOverlayProps {
  guide: GuideSessionState
  prompt: GuidePrompt
  /** 预览页使用左下停靠，避免压住右侧舞台和顶部返回/保存操作。 */
  layout?: GuideOverlayLayout
  mediaAvailability: GuideMediaAvailability
  /** 画布卡片 id → 当前显示名；只用于徽标，不含正文或路径。 */
  cardTitles: Readonly<Record<string, string>>
  importMedia: GuideMediaImportAction
  /** 读到的本机已有连接配置；null 表示未读定，不显示跳过按钮。 */
  modelConfigured: boolean | null
  onExpand: () => void
  onCollapse: () => void
  onOpenCatalog: () => void
  onOpenExample: () => void
  onCollapseForTrial: () => void
  onConfirmStep: () => void
  onSkip: () => void
  onSkipModel: () => void
  onPrevious: () => void
  onNext: () => void
  onResume: () => void
  onFinish: () => void
  onExit: () => void
}

type MediaAttempt = {
  key: string
  outcome: GuideMediaImportOutcome | 'importing'
}

const PILL_RING_RADIUS = 9
const PILL_RING_LENGTH = 2 * Math.PI * PILL_RING_RADIUS

const CARD_ROLE_LABEL: Readonly<Record<GuideArrangeCardRole, string>> = {
  script: '剧本',
  opening: '背景图',
  cue: '短声音',
  'next-background': '背景图',
  'character-before': '人物图',
  'character-after': '人物图',
  music: '音乐',
  prompt: '提示词'
}

const MEDIA_IMPORT_TEXT: Readonly<Record<Exclude<GuideMediaImportOutcome, 'cancelled'>, string>> = {
  imported: '文件到了，接下来把它拖上画布。',
  'wrong-kind': '选到的文件不是所需类型，没有算作导入成功。',
  failed: '文件没能导入，请看文件区的提示。',
  unverified: '还在确认导入结果，先不用再选一次。',
  unavailable: '文件选择器暂时没有打开，请从左侧文件区操作。'
}

type CardTitles = Readonly<Record<string, string>>

function roleLabel(role: GuideArrangeCardRole | null): string {
  return role ? CARD_ROLE_LABEL[role] : '卡片'
}

/** 绑定卡优先用画布上的名字；未绑定、空标题或读取失败时用中性角色名。 */
function cardLabel(role: GuideArrangeCardRole, cardId: string, cardTitles: CardTitles): string {
  const title = cardTitles[cardId]?.trim()
  return title && title.length > 0 ? title : roleLabel(role)
}

function boundCardOf(
  view: GuideArrangeView,
  role: GuideArrangeCardRole
): { role: GuideArrangeCardRole; cardId: string } | null {
  return view.boundCards.find((entry) => entry.role === role) ?? null
}

function endpointLabel(
  view: GuideArrangeView,
  role: GuideArrangeCardRole,
  cardTitles: CardTitles
): string {
  const bound = boundCardOf(view, role)
  return bound ? cardLabel(role, bound.cardId, cardTitles) : roleLabel(role)
}

function arrangeChipLabel(view: GuideArrangeView, cardTitles: CardTitles): string | null {
  if (view.complete) return '六拍已安排'
  if (view.cardKindLabel) {
    if (view.stage === 'place') return `需要${view.cardKindLabel}`
    return `当前：${view.cardRole ? endpointLabel(view, view.cardRole, cardTitles) : view.cardKindLabel}`
  }
  if (view.relationRoles) {
    const action = view.stage === 'connect' ? '连线' : '命名'
    return `${action} ${endpointLabel(view, view.relationRoles[0], cardTitles)} ↔ ${endpointLabel(view, view.relationRoles[1], cardTitles)}`
  }
  return null
}

function importStatusTone(outcome: GuideMediaImportOutcome): string {
  switch (outcome) {
    case 'imported':
      return 'success'
    case 'unverified':
      return 'info'
    case 'wrong-kind':
    case 'unavailable':
      return 'warning'
    case 'failed':
      return 'error'
    case 'cancelled':
      return 'info'
  }
}
function importButtonLabel(
  outcome: GuideMediaImportOutcome | 'importing' | null,
  available: boolean,
  label: string
): string {
  if (outcome === 'importing') return '正在打开文件…'
  if (outcome === 'unverified') return '等待确认导入结果'
  return available ? `导入其他${label}` : `导入${label}`
}

function ArrangeKindGlyph({ view }: { view: GuideArrangeView }): ReactElement | null {
  if (view.relationRoles) {
    return (
      <svg
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        aria-hidden="true"
      >
        <path d="M6.2 9.8 4.4 11.6a2.5 2.5 0 0 1-3.5-3.5l1.8-1.8" />
        <path d="m9.8 6.2 1.8-1.8a2.5 2.5 0 0 1 3.5 3.5l-1.8 1.8" />
        <path d="m5.4 10.6 5.2-5.2" strokeLinecap="round" />
      </svg>
    )
  }
  switch (view.cardKind) {
    case 'image':
      return (
        <svg
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.4"
          aria-hidden="true"
        >
          <rect x="1.7" y="2.6" width="12.6" height="10.8" rx="3" />
          <path d="m3.4 10.4 3-3.1 2.6 2.7 1.5-1.5 2.2 2.2" strokeLinecap="round" />
          <circle cx="5.2" cy="5.6" r=".9" />
        </svg>
      )
    case 'audio':
      return (
        <svg
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.4"
          aria-hidden="true"
        >
          <path d="M5.4 12.3V4.1l6.4-1v8.2" strokeLinecap="round" />
          <circle cx="3.8" cy="12.4" r="1.7" />
          <circle cx="10.2" cy="11.4" r="1.7" />
        </svg>
      )
    case 'prompt':
      return (
        <svg
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.4"
          aria-hidden="true"
        >
          <path d="M2.2 3.2h11.6v7.1H7l-3.5 3v-3H2.2z" strokeLinejoin="round" />
          <path d="M5 6.2h6M5 8.2h3.8" strokeLinecap="round" />
        </svg>
      )
    default:
      return null
  }
}

/**
 * 步骤签：工作台边缘的玻璃操作签。
 * 只显示当前动作与当前拍；容器不接收指针事件，面板表面才接收，
 * 因此不会拦住画布拖动。
 */
export function GuideStepOverlay({
  guide,
  prompt,
  layout = 'default',
  mediaAvailability,
  cardTitles,
  importMedia,
  modelConfigured,
  onExpand,
  onCollapse,
  onOpenCatalog,
  onOpenExample,
  onCollapseForTrial,
  onConfirmStep,
  onSkip,
  onSkipModel,
  onPrevious,
  onNext,
  onResume,
  onFinish,
  onExit
}: GuideStepOverlayProps): ReactElement {
  const step = guideStepById(guide.stepId)
  const navigation = guideNavigationViewOf(guide)
  const total = guideStepTotal()
  const number = step.number
  const expanded = !guide.collapsed
  const paused = guide.status === 'paused'
  const completed = guide.status === 'completed'
  const view = guideArrangeViewOf(guide)

  const panelRef = useRef<HTMLElement>(null)
  const pillRef = useRef<HTMLButtonElement>(null)
  const pillGroupRef = useRef<HTMLDivElement>(null)
  const textRef = useRef<HTMLDivElement>(null)
  const collapseFocusRef = useRef(false)
  const wasExpanded = useRef(expanded)
  const drag = useGuideDrag(layout)
  const [mediaAttempt, setMediaAttempt] = useState<MediaAttempt | null>(null)

  const arrangeKey = view
    ? `${view.beatId}:${view.stage}:${view.cardRole ?? ''}:${view.complete ? 'done' : 'open'}`
    : ''
  // 导入按钮的临时结果绑定到工程/场景和本次练习；切换、跳回或重进步骤后旧 Promise 失效。
  const attemptKey = guideImportAttemptKey({
    ...guide.scope,
    stepId: guide.stepId,
    stepAttempt: guide.stepAttempt,
    arrangeKey
  })
  const attemptKeyRef = useRef(attemptKey)
  attemptKeyRef.current = attemptKey
  const mediaKind =
    view && view.stage === 'place' && (view.cardKind === 'image' || view.cardKind === 'audio')
      ? view.cardKind
      : null
  const mediaAttemptHere =
    mediaAttempt && mediaAttempt.key === attemptKey ? mediaAttempt.outcome : null
  const importOutcome: Exclude<GuideMediaImportOutcome, 'cancelled'> | null =
    mediaAttemptHere === 'importing' || mediaAttemptHere === 'cancelled' ? null : mediaAttemptHere
  const availability = mediaKind ? mediaAvailability[mediaKind] : null
  const effectiveAvailable = availability === true || importOutcome === 'imported'

  useGuideMarkers(guide, mediaAttemptHere === 'importing' || mediaAttemptHere === 'unverified')
  const title = paused ? '跟做已停在这里' : (prompt.title ?? view?.title ?? step.title)
  const arrangePlaceAction =
    step.id === GUIDE_STEP_ID.arrangeScene &&
    view?.stage === 'place' &&
    view.cardKind === 'image' &&
    prompt.tone === 'action' &&
    availability === false
      ? GUIDE_ARRANGE_BACKGROUND_ACTION.import
      : null
  const body = paused
    ? '你已经离开刚才的场景。在这里继续，或先退出。'
    : (arrangePlaceAction ?? prompt.text)
  const textSignature = [
    guide.stepId,
    prompt.milestoneId ?? '',
    prompt.title ?? '',
    prompt.tone,
    prompt.text,
    body,
    view?.beatId ?? '',
    view?.stage ?? '',
    view?.complete ? 'complete' : ''
  ].join('|')

  useGuideOverlayMotion({ textRef, textSignature })

  useEffect(() => {
    setMediaAttempt(null)
  }, [attemptKey])

  useEffect(() => {
    const previous = wasExpanded.current
    wasExpanded.current = expanded
    if (!expanded && previous) {
      if (collapseFocusRef.current) {
        collapseFocusRef.current = false
        pillRef.current?.focus({ preventScroll: true })
      }
      return
    }
    if (expanded && !previous) {
      panelRef.current?.focus({ preventScroll: true })
    }
  }, [expanded])

  useEffect(() => {
    const node = expanded ? panelRef.current : pillGroupRef.current
    if (!node) return
    const reclamp = drag.reclamp.bind(null, node)
    reclamp()
    window.addEventListener('resize', reclamp)
    const observer = new ResizeObserver(reclamp)
    observer.observe(node)
    return () => {
      window.removeEventListener('resize', reclamp)
      observer.disconnect()
    }
  }, [drag.reclamp, expanded, layout])

  const handleImport = (): void => {
    if (!mediaKind || mediaAttemptHere === 'importing' || mediaAttemptHere === 'unverified') return
    const key = attemptKey
    setMediaAttempt({ key, outcome: 'importing' })
    void importMedia(mediaKind)
      .then((outcome) => {
        if (attemptKeyRef.current !== key) return
        if (outcome === 'cancelled') {
          setMediaAttempt(null)
          return
        }
        setMediaAttempt({ key, outcome })
      })
      .catch(() => {
        if (attemptKeyRef.current !== key) return
        setMediaAttempt({ key, outcome: 'failed' })
      })
  }

  if (guide.status === 'exited') {
    return <></>
  }

  if (!expanded) {
    const progress = Math.min(Math.max(number / total, 0), 1)
    return (
      <div className={styles.layer} data-layout={layout}>
        <div
          ref={pillGroupRef}
          className={styles.pillGroup}
          data-guide-layout={layout}
          data-dragging={drag.dragging || undefined}
          style={drag.style}
          onPointerDown={(event) => drag.start(event, pillGroupRef.current)}
          onClickCapture={(event) => {
            if (!drag.consumeClick()) return
            event.preventDefault()
            event.stopPropagation()
          }}
        >
          <button
            ref={pillRef}
            type="button"
            className={styles.pill}
            onClick={onExpand}
            aria-label={`展开教程，第 ${number} 步，共 ${total} 步`}
            title="展开教程"
            data-guide-overlay="collapsed"
          >
            <span className={styles.pillRing} aria-hidden="true">
              <svg viewBox="0 0 24 24" fill="none" strokeWidth="2.4">
                <circle className={styles.pillRingTrack} cx="12" cy="12" r={PILL_RING_RADIUS} />
                <circle
                  className={styles.pillRingValue}
                  cx="12"
                  cy="12"
                  r={PILL_RING_RADIUS}
                  strokeDasharray={PILL_RING_LENGTH}
                  strokeDashoffset={PILL_RING_LENGTH * (1 - progress)}
                  transform="rotate(-90 12 12)"
                />
              </svg>
              <span className={styles.pillRingNumber} aria-hidden="true">
                {number}
              </span>
            </span>
            <span className={styles.pillText}>展开教程 · 第 {number} 步</span>
            <svg
              className={styles.pillIcon}
              viewBox="0 0 14 14"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M3.5 8.5 7 5l3.5 3.5" />
            </svg>
          </button>
          <button
            type="button"
            className={styles.pillExit}
            onClick={onExit}
            aria-label="退出教程模式"
            title="退出教程"
            data-guide-exit="pill"
          >
            <svg
              viewBox="0 0 14 14"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              aria-hidden="true"
            >
              <path d="m3.9 3.9 6.2 6.2M10.1 3.9 3.9 10.1" />
            </svg>
          </button>
        </div>
      </div>
    )
  }

  const finishLabel = prompt.finishLabel ?? GUIDE_FINISH_LABEL
  const canCollapseForTrial =
    step.id === GUIDE_STEP_ID.playtestCandidate && guide.candidatePhase === 'ready'
  const canSkip = canSkipGuideStep(guide, prompt, completed)
  const canSkipModel =
    step.id === GUIDE_STEP_ID.configureModel &&
    guide.milestoneIndex === 0 &&
    modelConfigured === true &&
    !completed
  const canFinishStep = step.id === GUIDE_STEP_ID.exportBuild && !completed
  const hasExample = step.id === GUIDE_STEP_ID.arrangeScene
  const showNext =
    !paused && !completed && !view && !prompt.confirmLabel && prompt.tone === 'action'
  const boundRoles = view
    ? view.boundCards.filter((entry) => {
        if (entry.role === view.cardRole) return true
        return view.relationRoles?.includes(entry.role) ?? false
      })
    : []
  const importText = importOutcome ? MEDIA_IMPORT_TEXT[importOutcome] : null
  const importButtonVisible =
    mediaKind !== null && (availability !== null || mediaAttemptHere !== null)
  const importButtonDisabled = mediaAttemptHere === 'importing' || mediaAttemptHere === 'unverified'
  const importLabel = view?.cardKindLabel ?? '素材'

  return (
    <div className={styles.layer} data-layout={layout}>
      <aside
        ref={panelRef}
        className={styles.panel}
        style={drag.style}
        aria-label={`新手教程，第 ${number} 步「${step.title}」，共 ${total} 步`}
        data-guide-overlay="expanded"
        data-guide-layout={layout}
        data-guide-paused={paused || undefined}
        tabIndex={-1}
      >
        <header
          className={styles.top}
          onPointerDown={(event) => {
            const target = event.target as HTMLElement
            if (target.closest('button, a, input, textarea, select')) return
            drag.start(event, panelRef.current)
          }}
          data-dragging={drag.dragging || undefined}
        >
          <svg className={styles.grip} viewBox="0 0 10 14" fill="currentColor" aria-hidden="true">
            <circle cx="3" cy="4" r="1" />
            <circle cx="7" cy="4" r="1" />
            <circle cx="3" cy="8" r="1" />
            <circle cx="7" cy="8" r="1" />
            <circle cx="3" cy="12" r="1" />
            <circle cx="7" cy="12" r="1" />
          </svg>
          <div className={styles.progress}>
            <span className={styles.stepText}>
              第 {number} / {total} 步
            </span>
            <span className={styles.rail} aria-hidden="true">
              {Array.from({ length: total }, (_, index) => {
                const state =
                  index + 1 < number ? 'past' : index + 1 === number ? 'current' : 'upcoming'
                return <span key={index} className={styles.segment} data-state={state} />
              })}
            </span>
          </div>
          <span className={styles.topSpacer} />
          <button
            type="button"
            className={styles.collapseButton}
            onClick={() => {
              collapseFocusRef.current = true
              onCollapse()
            }}
            aria-label="收起教程"
            title="收起教程"
          >
            <svg
              viewBox="0 0 14 14"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M3.5 5.5 7 9l3.5-3.5" />
            </svg>
          </button>
          <button
            type="button"
            className={styles.panelExit}
            onClick={onExit}
            aria-label="退出教程模式"
            title="退出教程"
            data-guide-exit="panel"
          >
            <svg
              viewBox="0 0 14 14"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              aria-hidden="true"
            >
              <path d="m3.9 3.9 6.2 6.2M10.1 3.9 3.9 10.1" />
            </svg>
          </button>
        </header>

        <div className={styles.content}>
          {paused ? (
            <div className={styles.live} aria-live="polite" aria-atomic="true">
              <p className={styles.title}>
                <GuideCopyText text={title} />
              </p>
              <p className={styles.body}>
                <GuideCopyText text={body} />
              </p>
            </div>
          ) : completed ? (
            <div className={styles.live} aria-live="polite" aria-atomic="true">
              <p className={styles.title}>
                <GuideCopyText text={title} />
              </p>
              <p className={styles.body}>
                <GuideCopyText text={body} />
              </p>
            </div>
          ) : (
            <>
              {view ? (
                <div className={styles.live} aria-live="polite" aria-atomic="true">
                  <ArrangeHeader view={view} cardTitles={cardTitles} />
                  <div ref={textRef} className={styles.textGroup}>
                    <p className={styles.title}>
                      <GuideCopyText text={title} />
                    </p>
                    <p className={styles.body} data-tone={prompt.tone}>
                      <GuideCopyText text={body} />
                    </p>
                  </div>
                  <ArrangeDetails view={view} boundRoles={boundRoles} cardTitles={cardTitles} />
                </div>
              ) : (
                <div className={styles.live} aria-live="polite" aria-atomic="true">
                  <div ref={textRef} className={styles.textGroup}>
                    {showNext ? <span className={styles.actionLabel}>现在</span> : null}
                    <p className={styles.title}>
                      <GuideCopyText text={title} />
                    </p>
                    <p className={styles.body} data-tone={prompt.tone}>
                      <GuideCopyText text={prompt.text} />
                    </p>
                  </div>
                </div>
              )}

              {mediaKind ? (
                <div className={styles.mediaBlock} data-guide-media={mediaKind}>
                  {importText ? (
                    <p
                      className={styles.importStatus}
                      data-tone={importOutcome ? importStatusTone(importOutcome) : undefined}
                      role="status"
                    >
                      {importText}
                    </p>
                  ) : null}
                  {importButtonVisible ? (
                    <GuideButton
                      variant={effectiveAvailable ? 'secondary' : 'primary'}
                      className={styles.blockAction}
                      onClick={handleImport}
                      disabled={importButtonDisabled}
                      data-guide-import={mediaKind}
                    >
                      {importButtonLabel(mediaAttemptHere, effectiveAvailable, importLabel)}
                    </GuideButton>
                  ) : null}
                </div>
              ) : null}

              {showNext ? (
                <div className={styles.next}>
                  <span className={styles.nextLabel}>下一步</span>
                  <p className={styles.nextText}>
                    <GuideCopyText text={step.next} />
                  </p>
                </div>
              ) : null}

              {prompt.confirmLabel ? (
                <div className={styles.actions}>
                  <GuideButton
                    variant="primary"
                    className={styles.blockAction}
                    data-guide-target="guide-confirm"
                    onClick={onConfirmStep}
                  >
                    {step.confirmActionLabel ?? prompt.confirmLabel}
                  </GuideButton>
                </div>
              ) : null}

              {canCollapseForTrial ? (
                <div className={styles.actions}>
                  <GuideButton
                    variant="secondary"
                    className={styles.blockAction}
                    onClick={onCollapseForTrial}
                  >
                    收起，去试玩
                  </GuideButton>
                </div>
              ) : null}

              {canSkip ? (
                <div className={styles.actions}>
                  <GuideButton
                    variant="secondary"
                    data-guide-target="guide-skip"
                    className={styles.blockAction}
                    onClick={onSkip}
                  >
                    {step.skipLabel ?? '跳过这一步'}
                  </GuideButton>
                </div>
              ) : null}

              {canSkipModel ? (
                <div className={styles.actions}>
                  <GuideButton
                    variant="secondary"
                    className={styles.blockAction}
                    onClick={onSkipModel}
                    data-guide-target="guide-skip-model"
                  >
                    跳过模型设置
                  </GuideButton>
                </div>
              ) : null}

              {canFinishStep ? (
                <div className={styles.actions}>
                  <GuideButton
                    variant="secondary"
                    className={styles.blockAction}
                    onClick={onFinish}
                  >
                    {finishLabel}
                  </GuideButton>
                </div>
              ) : null}
            </>
          )}

          {paused ? (
            <div className={styles.pauseActions}>
              <GuideButton variant="secondary" onClick={onExit}>
                退出跟做
              </GuideButton>
              <GuideButton variant="primary" onClick={onResume}>
                在此继续
              </GuideButton>
            </div>
          ) : null}

          {completed ? (
            <div className={styles.actions}>
              <GuideButton variant="primary" className={styles.blockAction} onClick={onFinish}>
                {finishLabel}
              </GuideButton>
            </div>
          ) : null}
        </div>

        {!paused ? (
          <footer className={styles.foot}>
            <GuideStepNavigation navigation={navigation} onPrevious={onPrevious} onNext={onNext} />
            <div className={styles.footRow}>
              <button type="button" className={styles.textButton} onClick={onOpenCatalog}>
                步骤目录
              </button>
              {hasExample ? (
                <button type="button" className={styles.textButton} onClick={onOpenExample}>
                  看连线怎么做
                </button>
              ) : null}
              <span className={styles.footSpacer} />
              {!completed ? (
                <button type="button" className={styles.textButton} onClick={onExit}>
                  退出跟做
                </button>
              ) : null}
            </div>
          </footer>
        ) : null}
      </aside>
    </div>
  )
}

function GuideStepNavigation({
  navigation,
  onPrevious,
  onNext
}: {
  navigation: GuideNavigationView
  onPrevious: () => void
  onNext: () => void
}): ReactElement {
  return (
    <div className={styles.nav} role="group" aria-label="教程步骤导航">
      <button
        type="button"
        className={styles.navButton}
        data-guide-nav="previous"
        aria-disabled={navigation.previous.enabled ? undefined : true}
        aria-label={navigation.previous.ariaLabel}
        onClick={() => {
          if (navigation.previous.enabled) onPrevious()
        }}
      >
        <svg
          viewBox="0 0 14 14"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M8.5 3.5 5 7l3.5 3.5" />
        </svg>
        <span>{navigation.previous.label}</span>
      </button>
      <button
        type="button"
        className={styles.navButton}
        data-guide-nav="next"
        aria-disabled={navigation.next.enabled ? undefined : true}
        aria-label={navigation.next.ariaLabel}
        onClick={() => {
          if (navigation.next.enabled) onNext()
        }}
      >
        <span>{navigation.next.label}</span>
        <svg
          viewBox="0 0 14 14"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M5.5 3.5 9 7l-3.5 3.5" />
        </svg>
      </button>
    </div>
  )
}

function ArrangeHeader({
  view,
  cardTitles
}: {
  view: GuideArrangeView
  cardTitles: CardTitles
}): ReactElement {
  const chipLabel = arrangeChipLabel(view, cardTitles)
  return (
    <div className={styles.arrangeHeader}>
      <div className={styles.arrangeTop}>
        <span className={styles.beatCount}>
          本步第 {view.beatNumber} / {view.beatTotal} 拍
        </span>
        <span className={styles.beatRail} aria-hidden="true">
          {Array.from({ length: view.beatTotal }, (_, index) => {
            const state =
              view.complete || index < view.beatNumber - 1
                ? 'past'
                : index === view.beatNumber - 1
                  ? 'current'
                  : 'upcoming'
            return <span key={index} className={styles.beatSegment} data-state={state} />
          })}
        </span>
        {chipLabel ? (
          <span
            className={styles.kindChip}
            data-kind={view.relationRoles ? 'relation' : (view.cardKind ?? undefined)}
          >
            <span className={styles.kindGlyph} aria-hidden="true">
              <ArrangeKindGlyph view={view} />
            </span>
            {chipLabel}
          </span>
        ) : null}
      </div>
    </div>
  )
}

function ArrangeDetails({
  view,
  boundRoles,
  cardTitles
}: {
  view: GuideArrangeView
  boundRoles: readonly { role: GuideArrangeCardRole; cardId: string }[]
  cardTitles: CardTitles
}): ReactElement | null {
  if (view.complete) {
    return (
      <div className={styles.boundRow}>
        <span className={styles.boundLabel}>已就位</span>
        {boundRoles.length === 0 ? (
          <span className={styles.boundChipEmpty}>按当前画布核对</span>
        ) : (
          boundRoles.map((entry) => (
            <span key={entry.role} className={styles.boundChip}>
              <span className={styles.boundDot} aria-hidden="true" />
              {cardLabel(entry.role, entry.cardId, cardTitles)}
            </span>
          ))
        )}
      </div>
    )
  }

  if (view.relationRoles) {
    const connected = Boolean(view.relationId) || view.complete
    return (
      <div className={styles.relationMap} data-connected={connected}>
        <span
          className={styles.endpoint}
          data-bound={boundRoles.some((entry) => entry.role === view.relationRoles?.[0])}
        >
          {endpointLabel(view, view.relationRoles[0], cardTitles)}
        </span>
        <svg
          className={styles.connector}
          viewBox="0 0 64 12"
          preserveAspectRatio="none"
          fill="none"
          aria-hidden="true"
        >
          <path className={styles.connectorLine} d="M3 6h58" />
          <circle className={styles.connectorNode} cx="3" cy="6" r="2.4" />
          <circle className={styles.connectorNode} cx="61" cy="6" r="2.4" />
        </svg>
        <span
          className={styles.endpoint}
          data-bound={boundRoles.some((entry) => entry.role === view.relationRoles?.[1])}
        >
          {endpointLabel(view, view.relationRoles[1], cardTitles)}
        </span>
      </div>
    )
  }

  if (boundRoles.length === 0) return null
  return (
    <div className={styles.boundRow}>
      <span className={styles.boundLabel}>本拍已就位</span>
      {boundRoles.map((entry) => (
        <span key={entry.role} className={styles.boundChip}>
          <span className={styles.boundDot} aria-hidden="true" />
          {cardLabel(entry.role, entry.cardId, cardTitles)}
        </span>
      ))}
    </div>
  )
}
