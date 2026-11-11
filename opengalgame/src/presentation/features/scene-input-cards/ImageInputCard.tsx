import type { ReactElement } from 'react'

import { useShallow } from 'zustand/react/shallow'

import { sourceFactsOf } from '../workbench-session/workbenchSessionSelectors'

import { useWorkbenchSessionStore } from '../workbench-session/workbenchSession.store'
import type { SessionImageCard } from '../workbench-session/workbenchSession.types'
import { useWorkbenchCommands } from '../workbench-session/workbenchCommandsContext'
import { MediaPreview } from '../media-preview/MediaPreview'
import { MediaFallback } from './MediaFallback'
import { MediaPurposeText } from './MediaPurposeText'
import { mediaBlockStateOf } from './cardPresentation'
import styles from './SceneInputCards.module.css'

/** 图片卡片内容。来源可读时显示真实图片，按原始比例缩小、不裁切。 */
export function ImageInputCard({
  card,
  onEditSummary
}: {
  card: SessionImageCard
  onEditSummary?: () => void
}): ReactElement {
  const source = useWorkbenchSessionStore(
    useShallow((state) => sourceFactsOf(state, card.sourceId))
  )
  const commands = useWorkbenchCommands()
  const blocked = source.disconnected || !source.readable
  return (
    <>
      <div className={styles.mediaStage} data-media-kind="image">
        <span className={styles.mediaKind} aria-hidden="true">
          图片
        </span>
        {blocked ? (
          <MediaFallback kind="image" state={mediaBlockStateOf(source)} />
        ) : (
          <MediaPreview
            sourceId={card.sourceId}
            kind="image"
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
