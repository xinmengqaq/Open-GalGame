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
  /** 打开卡片的标题与用途说明编辑。 */
  openEdit: (cardId: string) => void
  activeRelationId: string | null
  isConnecting: boolean
  connectingFromCardId: string | null
  connectingFromKind: SessionCardKind | null
  /** 连接被拒绝的起点卡片；卡片外壳可据此做短回弹或轮廓反馈。 */
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
