import type { ReactElement } from 'react'

import { useShallow } from 'zustand/react/shallow'

import { AudioDeckUnavailable, MediaPreview } from '../media-preview/MediaPreview'
import { sourceDocumentFacts } from '../workbench-session/workbenchSessionMapper'
import { sourceFactsOf } from '../workbench-session/workbenchSessionSelectors'
import { MediaPurposeText } from './MediaPurposeText'
import { mediaBlockStateOf } from './cardPresentation'
import styles from './SceneInputCards.module.css'

import { useWorkbenchSessionStore } from '../workbench-session/workbenchSession.store'
import type { SessionAudioCard } from '../workbench-session/workbenchSession.types'

/** 音频卡片内容。来源可读时提供真实播放、进度、时长和能量条。 */
export function AudioInputCard({
  card,
  onEditSummary
}: {
  card: SessionAudioCard
  onEditSummary?: () => void
}): ReactElement {
  const source = useWorkbenchSessionStore(
    useShallow((state) => sourceFactsOf(state, card.sourceId))
  )
  const facts = sourceDocumentFacts(card, source.detail)
  const summary = card.summary.trim().length > 0 ? card.summary : (facts.description ?? '')
  const blocked = source.disconnected || !source.readable
  return (
    <div className={styles.cardBody}>
      <div className={styles.cardCopy}>
        <h3 className={styles.title}>{card.title}</h3>
        <MediaPurposeText summary={summary} onEdit={onEditSummary} />
      </div>
      {blocked ? (
        <AudioDeckUnavailable title={card.title} message={mediaBlockStateOf(source)} />
      ) : (
        <MediaPreview sourceId={card.sourceId} kind="audio" title={card.title} />
      )}
    </div>
  )
}
