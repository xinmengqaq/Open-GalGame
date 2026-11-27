import { useEffect, useState, useSyncExternalStore, type ReactElement } from 'react'
import { createPortal } from 'react-dom'

import { currentPageModal, subscribePageModal } from '../../components/dialogElement'
import theme from '../../pages/workbench/workbenchTheme.module.css'
import { GuideDialog } from './GuideDialog'
import { GuideEntry } from './GuideEntry'
import { GuideStepOverlay } from './GuideStepOverlay'
import type { GuideMediaImportAction } from './guideMedia'
import {
  UNKNOWN_GUIDE_MEDIA_AVAILABILITY,
  type GuideContextSnapshot,
  type GuideMediaAvailability,
  type GuidePage,
  type GuideObservationSource
} from './guideObservation'
import { previewGuidePrompt } from './guidePrompt'
import { GUIDE_STEP_ID } from './guideSteps'
import {
  readGuidePreviewHost,
  readGuideTopLayerHost,
  subscribeGuidePreviewHost,
  subscribeGuideTopLayerHost
} from './guideTopLayer'
import { useGuideSession } from './useGuideSession'
import { useGuideReturnPulse } from './useGuideReturnPulse'

interface BeginnerGuideHostProps {
  restoreEntryRequest?: number
  page: 'home' | 'projects' | 'workbench'
  observationSource: GuideObservationSource
  importMedia: GuideMediaImportAction
  /** 读取本机是否已有保存的连接配置；缺省时不显示跳过按钮。 */
  readModelConfigured?: () => Promise<boolean>
}

function readMediaAvailability(source: GuideObservationSource): GuideMediaAvailability {
  try {
    return source.readCurrent().mediaAvailability
  } catch {
    return UNKNOWN_GUIDE_MEDIA_AVAILABILITY
  }
}

function readCardTitles(source: GuideObservationSource): Readonly<Record<string, string>> {
  try {
    return source.readCurrent().cardTitles ?? {}
  } catch {
    return {}
  }
}

/**
 * 新手指引的唯一挂载入口。
 * 只负责把邀请、独立入口、步骤浮层和教程弹窗挂到 body 上；
 * 业务数据一律来自观察源，不接收 clients、store 或页面组件。
 */
export function BeginnerGuideHost({
  restoreEntryRequest = 0,
  page,
  observationSource,
  importMedia,
  readModelConfigured
}: BeginnerGuideHostProps): ReactElement | null {
  const { session, actions } = useGuideSession({ source: observationSource })
  const guidePage: GuidePage = page === 'projects' ? 'project-list' : page
  const { restoreEntry } = actions
  useEffect(() => {
    if (restoreEntryRequest > 0) restoreEntry()
  }, [restoreEntryRequest, restoreEntry])
  const { showInvitation, syncContext } = actions
  const [previewOpen, setPreviewOpen] = useState(() => {
    try {
      return observationSource.readCurrent().previewOpen
    } catch {
      return false
    }
  })
  const [generationDrawerOpen, setGenerationDrawerOpen] = useState(() => {
    try {
      return observationSource.readCurrent().generationDrawerOpen
    } catch {
      return false
    }
  })
  const modal = useSyncExternalStore(subscribePageModal, currentPageModal, () => null)
  const drawerTopLayerHost = useSyncExternalStore(
    subscribeGuideTopLayerHost,
    readGuideTopLayerHost,
    () => null
  )
  const previewTopLayerHost = useSyncExternalStore(
    subscribeGuidePreviewHost,
    readGuidePreviewHost,
    () => null
  )
  // 教程跟随当前最上层的真实表面：原生模态 > 试玩预览 > 生成抽屉 > 页面。
  const topLayerHost =
    modal ??
    (previewOpen ? previewTopLayerHost : null) ??
    (generationDrawerOpen ? drawerTopLayerHost : null) ??
    document.body
  const [mediaAvailability, setMediaAvailability] = useState(() =>
    readMediaAvailability(observationSource)
  )
  const [cardTitles, setCardTitles] = useState(() => readCardTitles(observationSource))
  const [modelConfigured, setModelConfigured] = useState<boolean | null>(null)
  const guideStepId = session.guide?.stepId ?? null

  useEffect(() => {
    if (!session.reading || guideStepId !== GUIDE_STEP_ID.configureModel) {
      setModelConfigured(null)
      return
    }
    if (!readModelConfigured) {
      setModelConfigured(null)
      return
    }
    let active = true
    void readModelConfigured()
      .then((configured) => {
        if (active) setModelConfigured(configured)
      })
      .catch(() => {
        if (active) setModelConfigured(null)
      })
    return () => {
      active = false
    }
  }, [guideStepId, readModelConfigured, session.reading])

  useEffect(() => {
    if (guidePage !== 'home') return
    if (!session.shouldAutoInvite) return
    showInvitation()
  }, [guidePage, session.shouldAutoInvite, showInvitation])

  // 预览开关决定教程停靠表面和入口位置；教程关闭时也保留订阅，
  // 这样退出后入口仍能落在预览左下，而不是页面右下。
  useEffect(() => {
    const subscribe = observationSource.subscribePreview
    if (!subscribe) return
    return subscribe.call(observationSource, setPreviewOpen)
  }, [observationSource])

  // 只在阅读模式下同步完整上下文，避免教程关闭后画布平移或输入仍触发目录扫描。
  useEffect(() => {
    if (!session.reading) return
    const subscribe = observationSource.subscribeContext
    if (!subscribe) return
    const applySnapshot = (snapshot: GuideContextSnapshot): void => {
      setPreviewOpen(snapshot.previewOpen)
      setGenerationDrawerOpen(snapshot.generationDrawerOpen)
      setMediaAvailability(snapshot.mediaAvailability)
      setCardTitles(snapshot.cardTitles ?? {})
      syncContext(snapshot)
    }
    try {
      applySnapshot(observationSource.readCurrent())
    } catch {
      // 读不到当前上下文时保持订阅，等下一次上下文通知。
    }
    return subscribe.call(observationSource, applySnapshot)
  }, [observationSource, session.reading, syncContext])

  // 预览里当前可做的动作和页面外不同：第 7 步不再说「打开预览」，
  // 第 8 步先指向实际「返回工作台」；只影响显示，不写回会话状态。
  const overlayPrompt =
    previewOpen && session.guide !== null
      ? (previewGuidePrompt(session.guide) ?? session.prompt)
      : session.prompt

  // 进入第 8 步且仍在预览时，脉冲真实返回按钮一次，并保持可辨光环。
  useGuideReturnPulse(
    previewOpen &&
      session.mode === 'reading' &&
      session.guide?.stepId === GUIDE_STEP_ID.exportBuild &&
      session.guide.status === 'following'
  )

  // 教程浮窗不因进入候选、预览或抽屉而收起；只有用户点收起/退出才改变。
  const overlay =
    session.mode === 'reading' &&
    session.guide !== null &&
    overlayPrompt !== null &&
    (!overlayPrompt.hidden || session.guide.collapsed) ? (
      <GuideStepOverlay
        guide={session.guide}
        prompt={overlayPrompt}
        layout={previewOpen ? 'preview' : 'default'}
        mediaAvailability={mediaAvailability}
        cardTitles={cardTitles}
        importMedia={importMedia}
        modelConfigured={modelConfigured}
        onExpand={actions.expand}
        onCollapse={actions.collapse}
        onOpenCatalog={actions.openCatalog}
        onOpenExample={actions.openExample}
        onCollapseForTrial={actions.collapseForTrial}
        onConfirmStep={actions.confirmStep}
        onSkip={actions.skipDialogue}
        onSkipModel={actions.skipModelConfig}
        onPrevious={actions.previous}
        onNext={actions.next}
        onResume={actions.resume}
        onFinish={actions.finish}
        onExit={actions.exit}
      />
    ) : null

  return createPortal(
    // portal 不改变原生模态和焦点，只在教程自己的根上承接工作台变量；
    // 不把主题提到 body，首页与工作台的其它元素不受影响。
    // 抽屉/预览打开时挂进其内容，避免被模态的 aria-hidden 和焦点陷阱排除。
    <div className={theme.theme} data-guide-portal="true">
      {modal === null && session.mode === 'idle' && !session.entryHidden && (
        <GuideEntry
          lastStepId={session.lastStepId}
          layout={previewOpen ? 'preview' : 'default'}
          onOpen={() => actions.openInvitation()}
          onClose={() => actions.hideEntry()}
        />
      )}
      {overlay}
      <GuideDialog
        session={session}
        onDismissInvitation={actions.dismissInvitation}
        onStartTutorial={() => actions.startTutorial()}
        onCloseCatalog={actions.closeCatalog}
        onSelectStep={actions.selectStep}
        onCloseExample={actions.closeExample}
      />
    </div>,
    topLayerHost ?? document.body
  )
}
