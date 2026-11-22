import { createContext } from 'react'

import type {
  SessionCardKind,
  SessionCardLayout
} from '../workbench-session/workbenchSession.types'

export type CanvasNodeActions = {
  beginLayoutInteract: () => void
  commitCardLayout: (cardId: string, layout: SessionCardLayout) => void
  openRelation: (relationId: string) => void
  detachRecord: (relationId: string) => void
  openEdit: (cardId: string) => void
  activeRelationId: string | null
  isConnecting: boolean
  connectingFromCardId: string | null
  connectingFromKind: SessionCardKind | null
  rejectedCardId?: string | null
}

export const CanvasNodeContext = createContext<CanvasNodeActions>({
  beginLayoutInteract: () => undefined,
  commitCardLayout: () => undefined,
  openRelation: () => undefined,
  detachRecord: () => undefined,
  openEdit: () => undefined,
  activeRelationId: null,
  isConnecting: false,
  connectingFromCardId: null,
  connectingFromKind: null,
  rejectedCardId: null
})
