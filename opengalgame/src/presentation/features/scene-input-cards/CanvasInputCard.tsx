import type { ReactElement } from 'react'

import { useShallow } from 'zustand/react/shallow'

import { SourceStatus, sourceStatusOf } from '../../components/SourceStatus'
import { AudioInputCard } from './AudioInputCard'
import { CanvasCardFrame } from './CanvasCardFrame'
import { DocumentInputCard, DocumentReadAction } from './DocumentInputCard'
import { ImageInputCard } from './ImageInputCard'
import { PresetInputCard } from './PresetInputCard'
import { PromptInputCard } from './PromptInputCard'
import { VideoInputCard } from './VideoInputCard'
import { isPreviewCard, isSourceCard } from '../workbench-session/contentKindLabel'
import { useWorkbenchCommands } from '../workbench-session/workbenchCommandsContext'
import { sourceFactsOf } from '../workbench-session/workbenchSessionSelectors'

import { useWorkbenchSessionStore } from '../workbench-session/workbenchSession.store'
import type { SessionCard } from '../workbench-session/workbenchSession.types'

interface CanvasInputCardProps {
  card: SessionCard
  selected: boolean
  /** 媒体卡用途说明的可见编辑入口；由画布节点提供打开编辑对话框。 */
  onEditSummary?: () => void
}

/**
 * 画布卡片入口：共同外框和来源状态在这里接线，内容由各类卡片提供。
 * 预设卡的状态来自卡片内部，因此由预设卡自己持有外框。
 */
export function CanvasInputCard({
  card,
  selected,
  onEditSummary
}: CanvasInputCardProps): ReactElement {
  const commands = useWorkbenchCommands()
  const sourceId = isSourceCard(card) ? card.sourceId : ''
  const source = useWorkbenchSessionStore(useShallow((state) => sourceFactsOf(state, sourceId)))
  const sourceUnavailable = isSourceCard(card) && (source.disconnected || !source.readable)

  if (card.kind === 'animation' || card.kind === 'effect') {
    return <PresetInputCard card={card} selected={selected} />
  }

  const layout = isPreviewCard(card.kind) ? 'media' : card.kind === 'prompt' ? 'paper' : 'card'
  const fill = isPreviewCard(card.kind) || card.kind === 'prompt'

  return (
    <CanvasCardFrame
      card={card}
      selected={selected}
      layout={layout}
      fill={fill}
      risk={sourceUnavailable}
      status={
        sourceUnavailable && !isPreviewCard(card.kind) ? (
          <SourceStatus code={sourceStatusOf(source)} motion />
        ) : undefined
      }
      actions={
        card.kind === 'document' ? (
          <DocumentReadAction onOpen={() => commands.openDocumentLayer(card.cardId)} />
        ) : undefined
      }
    >
      {renderBody(card, onEditSummary)}
    </CanvasCardFrame>
  )
}

function renderBody(
  card: Exclude<SessionCard, { kind: 'animation' } | { kind: 'effect' }>,
  onEditSummary?: () => void
): ReactElement {
  if (card.kind === 'document') return <DocumentInputCard card={card} />
  if (card.kind === 'prompt') return <PromptInputCard card={card} />
  if (card.kind === 'image') return <ImageInputCard card={card} onEditSummary={onEditSummary} />
  if (card.kind === 'audio') return <AudioInputCard card={card} onEditSummary={onEditSummary} />
  return <VideoInputCard card={card} onEditSummary={onEditSummary} />
}
