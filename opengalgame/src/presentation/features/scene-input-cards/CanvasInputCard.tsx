import type { ReactElement } from 'react'

import { useShallow } from 'zustand/react/shallow'

import { SourceStatus } from '../../components/SourceStatus'
import { sourceStatusOf } from '../../components/sourceStatusMapping'
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
  onEditSummary?: () => void
}

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
