import { useEffect, useRef, useState, type ReactElement } from 'react'

import { Dialog } from '../../components/Dialog'
import { GuideButton } from './GuideButton'
import { GuideConnectionFigure, GuideInviteFigure } from './GuideFigures'
import styles from './GuideDialog.module.css'
import { GUIDE_STEPS, GUIDE_STEP_ID, guideStepById, type GuideStepId } from './guideSteps'
import type { GuideSessionView } from './useGuideSession'

interface GuideDialogProps {
  session: GuideSessionView
  onDismissInvitation: () => void
  onStartTutorial: () => void
  onCloseCatalog: () => void
  onSelectStep: (stepId: GuideStepId) => void
  onCloseExample: () => void
}

type GuideDialogMode = 'invitation' | 'catalog' | 'example'

interface CatalogOverflow {
  scrollable: boolean
  remaining: number
  atBottom: boolean
}

const NO_CATALOG_OVERFLOW: CatalogOverflow = { scrollable: false, remaining: 0, atBottom: false }

/**
 * 教程唯一的弹窗入口：邀请、目录、第 4 步图解共用同一个 Dialog 外壳，
 * 只换内容，不叠第二个 dialog，也不叠第二层遮罩。
 */
export function GuideDialog({
  session,
  onDismissInvitation,
  onStartTutorial,
  onCloseCatalog,
  onSelectStep,
  onCloseExample
}: GuideDialogProps): ReactElement {
  const mode: GuideDialogMode | null = session.exampleOpen
    ? 'example'
    : session.catalogOpen
      ? 'catalog'
      : session.invitationOpen
        ? 'invitation'
        : null

  const currentStepId = session.guide?.stepId ?? null
  const exampleStep = currentStepId ? guideStepById(currentStepId) : GUIDE_STEPS[0]
  const demoStep = exampleStep.id === GUIDE_STEP_ID.arrangeScene
  const [playToken, setPlayToken] = useState(0)
  const [catalogOverflow, setCatalogOverflow] = useState<CatalogOverflow>(NO_CATALOG_OVERFLOW)
  const catalogRef = useRef<HTMLDivElement>(null)

  // 目录只有真的溢出时才提示“向下还有几步”，矮窗里第一眼就知道八步没走完。
  useEffect(() => {
    if (mode !== 'catalog') {
      return undefined
    }
    const node = catalogRef.current
    if (!node) {
      return undefined
    }

    const measure = (): void => {
      if (node.scrollHeight - node.clientHeight <= 1) {
        setCatalogOverflow((current) => (current.scrollable ? NO_CATALOG_OVERFLOW : current))
        return
      }
      const viewportBottom = node.getBoundingClientRect().bottom
      let remaining = 0
      node.querySelectorAll<HTMLElement>('[data-guide-catalog-row]').forEach((row) => {
        if (row.getBoundingClientRect().bottom > viewportBottom + 1) {
          remaining += 1
        }
      })
      const atBottom = node.scrollTop + node.clientHeight >= node.scrollHeight - 2
      setCatalogOverflow((current) =>
        current.scrollable && current.remaining === remaining && current.atBottom === atBottom
          ? current
          : { scrollable: true, remaining, atBottom }
      )
    }

    const frame = window.requestAnimationFrame(measure)
    const observer = new ResizeObserver(measure)
    observer.observe(node)
    const content = node.firstElementChild
    if (content) {
      observer.observe(content)
    }
    node.addEventListener('scroll', measure, { passive: true })
    window.addEventListener('resize', measure)

    return () => {
      window.cancelAnimationFrame(frame)
      observer.disconnect()
      node.removeEventListener('scroll', measure)
      window.removeEventListener('resize', measure)
    }
  }, [mode])

  const handleClose = (): void => {
    // 关闭图解即丢弃播放令牌；重开从初始图开始，不自动重播。
    setPlayToken(0)
    if (mode === 'example') {
      onCloseExample()
      return
    }
    if (mode === 'catalog') {
      onCloseCatalog()
      return
    }
    if (mode === 'invitation') {
      onDismissInvitation()
    }
  }

  const title =
    mode === 'invitation'
      ? '把一段戏做成能玩的场景'
      : mode === 'catalog'
        ? '选一段接着做'
        : demoStep
          ? '让两张卡说清楚彼此的关系'
          : exampleStep.title
  const subtitle =
    mode === 'catalog'
      ? '跳到别处不会替你完成画布操作。'
      : mode === 'example'
        ? `第 ${exampleStep.number} 步`
        : undefined

  const actions =
    mode === 'invitation' ? (
      <>
        <p className={styles.invitationLine}>
          选自己的剧本、画面和声音。<span className={styles.noBreak}>我们</span>
          从第一张卡开始，一起做到能试玩。
        </p>
        <div className={styles.invitationActions}>
          <GuideButton variant="secondary" onClick={handleClose}>
            这次不看
          </GuideButton>
          <GuideButton
            variant="primary"
            onClick={() => {
              setPlayToken(0)
              onStartTutorial()
            }}
          >
            开始跟做
          </GuideButton>
        </div>
      </>
    ) : mode === 'catalog' ? (
      <GuideButton variant="secondary" onClick={handleClose}>
        {session.guide ? '返回当前步骤' : '关闭'}
      </GuideButton>
    ) : mode === 'example' ? (
      <>
        <GuideButton variant="secondary" onClick={handleClose}>
          回到画布
        </GuideButton>
        {demoStep ? (
          <GuideButton variant="primary" onClick={() => setPlayToken((token) => token + 1)}>
            {playToken > 0 ? '重新播放' : '播放连线'}
          </GuideButton>
        ) : null}
      </>
    ) : null

  const body =
    mode === 'invitation' ? (
      <GuideInviteFigure />
    ) : mode === 'catalog' ? (
      <nav className={styles.catalog} aria-label="教程目录">
        <div className={styles.catalogViewport}>
          <div className={styles.catalogScroll} ref={catalogRef} data-guide-scroll="catalog">
            <ol className={styles.catalogList}>
              {GUIDE_STEPS.map((step) => {
                const current = currentStepId === step.id
                return (
                  <li key={step.id} className={styles.catalogItem}>
                    <button
                      type="button"
                      className={styles.catalogRow}
                      aria-current={current ? 'step' : undefined}
                      data-guide-catalog-row="true"
                      onClick={() => {
                        setPlayToken(0)
                        onSelectStep(step.id)
                      }}
                    >
                      <span className={styles.catalogNumber} aria-hidden="true">
                        {step.number}
                      </span>
                      <span className={styles.catalogLabel}>{step.catalogLabel}</span>
                      {current ? <span className={styles.currentMark}>读到这里</span> : null}
                      <svg
                        className={styles.catalogChevron}
                        viewBox="0 0 12 12"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.4"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        aria-hidden="true"
                      >
                        <path d="M4.5 2.5 8 6l-3.5 3.5" />
                      </svg>
                    </button>
                  </li>
                )
              })}
            </ol>
          </div>
          {catalogOverflow.scrollable && !catalogOverflow.atBottom ? (
            <div className={styles.scrollHint} aria-hidden="true">
              <span>
                {catalogOverflow.remaining > 0
                  ? `向下还有 ${catalogOverflow.remaining} 步`
                  : '向下滚动'}
              </span>
              <svg
                viewBox="0 0 12 12"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M2.6 4.6 6 8l3.4-3.4" />
              </svg>
            </div>
          ) : null}
        </div>
      </nav>
    ) : mode === 'example' ? (
      demoStep ? (
        <div className={styles.connection}>
          <figure className={styles.connectionFigureBlock}>
            <GuideConnectionFigure playToken={playToken} />
            <figcaption className={styles.caption}>从端口接到端口，然后给这条线命名。</figcaption>
          </figure>
        </div>
      ) : (
        <p className={styles.exampleFallback}>
          这一步没有单独的连线图示。按步骤签里的动作继续即可。
        </p>
      )
    ) : null

  return (
    <div className={styles.dialogHost} data-mode={mode ?? undefined}>
      <Dialog
        open={mode !== null}
        title={title}
        subtitle={subtitle}
        size="form"
        allowClose
        onClose={handleClose}
        closeLabel={mode === 'catalog' ? '关闭步骤目录' : undefined}
        actions={actions}
      >
        {body}
      </Dialog>
    </div>
  )
}
