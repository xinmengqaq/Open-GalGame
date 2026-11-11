import type { ReactElement } from 'react'

import { useShallow } from 'zustand/react/shallow'

import { sourceFactsOf } from '../workbench-session/workbenchSessionSelectors'

import { useWorkbenchSessionStore } from '../workbench-session/workbenchSession.store'
import type { SessionVideoCard } from '../workbench-session/workbenchSession.types'
import { useWorkbenchCommands } from '../workbench-session/workbenchCommandsContext'
import { MediaPreview } from '../media-preview/MediaPreview'
import { MediaFallback } from './MediaFallback'
import { MediaPurposeText } from './MediaPurposeText'
import { mediaBlockStateOf } from './cardPresentation'
import styles from './SceneInputCards.module.css'

/** 视频卡片内容。真实视频按原始比例缩放，播放、进度与时长在卡内提供。 */
export function VideoInputCard({
  card,
  onEditSummary
}: {
  card: SessionVideoCard
  onEditSummary?: () => void
}): ReactElement {
  const source = useWorkbenchSessionStore(
    useShallow((state) => sourceFactsOf(state, card.sourceId))
  )
  const commands = useWorkbenchCommands()
  const blocked = source.disconnected || !source.readable
  return (
    <>
      <div className={styles.mediaStage} data-media-kind="video">
        <span className={styles.mediaKind} aria-hidden="true">
          视频
        </span>
        {blocked ? (
          <MediaFallback kind="video" state={mediaBlockStateOf(source)} />
        ) : (
          <MediaPreview
            sourceId={card.sourceId}
            kind="video"
            title={card.title}
            onNaturalSize={(width, height) => commands.fitPreviewAspect(card.cardId, width, height)}
          />
        )}
      </div>
      <footer className={styles.mediaFooter}>
        <h3 className={styles.mediaTitle}>{card.title}</h3>
        <MediaPurposeText summary={card.summary} onEdit={onEditSummary} />
      </footer>
    </>
  )
}
