import type { GuideFact } from '../features/beginner-guide/guideObservation'
import type {
  CanvasCardAction,
  CanvasSavedAction,
  CardEditedAction,
  CardSelectedAction,
  DocumentClosedAction,
  DocumentOpenedAction,
  InputSummaryOpenedAction,
  PromptBodySavedAction,
  RelationAction,
  WorkbenchActionScope
} from '../features/workbench-session/workbenchActionObservers'
import type { GuideActionFactContext } from './guideActionFactContext'

const ASSET_CARD_KINDS: ReadonlySet<string> = new Set(['image', 'audio', 'video'])
const TRACKED_CARD_KINDS: ReadonlySet<string> = new Set([
  'document',
  'image',
  'audio',
  'video',
  'prompt'
])

export interface CanvasActionObservation {
  onCardCreated(card: CanvasCardAction): void
  onCardSelected(card: CardSelectedAction): void
  onCardDeleted(card: CanvasCardAction): void
  onDocumentOpened(event: DocumentOpenedAction): void
  onDocumentClosed(event: DocumentClosedAction): void
  onCardEdited(event: CardEditedAction): void
  onPromptBodySaved(event: PromptBodySavedAction): void
  onRelationCreated(event: RelationAction): void
  onRelationNamed(event: RelationAction): void
  onRelationDeleted(event: RelationAction): void
  onCanvasSaved(event: CanvasSavedAction): void
  onInputSummaryOpened(event: InputSummaryOpenedAction): void
}

/**
 * 步骤 3 后半、步骤 4 和步骤 5 前两个动作的观察源。
 *
 * 只接收命令层在真实成功点上报的动作；不读取卡片/关系/保存状态快照，因此
 * 加载、恢复、撤销或已有数据都不会被误判成新动作。作用域必须是当前工作台
 * 会话，切工程/切场景后迟到的回调直接丢弃。
 */
export function createCanvasActionObservation(
  context: GuideActionFactContext
): CanvasActionObservation {
  function accepts(scope: WorkbenchActionScope): boolean {
    if (!context.active()) return false
    if (scope.projectId.length === 0 || scope.sceneId.length === 0 || scope.canvasId.length === 0) {
      return false
    }
    const snapshot = context.readCurrent()
    return (
      snapshot.page === 'workbench' &&
      snapshot.projectId === scope.projectId &&
      snapshot.sceneId === scope.sceneId &&
      snapshot.canvasId === scope.canvasId
    )
  }

  function emitRelation(
    kind: 'relationCreated' | 'relationNamed' | 'relationDeleted',
    event: RelationAction
  ): void {
    if (!accepts(event.scope) || event.relationId.length === 0) return
    if (event.fromCardId.length === 0 || event.toCardId.length === 0) return
    const fact: GuideFact = {
      kind,
      ...context.factBase(),
      scope: event.scope,
      relationId: event.relationId,
      fromCardId: event.fromCardId,
      toCardId: event.toCardId,
      fromCardKind: event.fromCardKind,
      toCardKind: event.toCardKind
    }
    context.emit(fact)
  }

  return {
    onCardCreated(card) {
      if (!accepts(card.scope) || card.cardId.length === 0) return
      if (!TRACKED_CARD_KINDS.has(card.cardKind)) return
      const fact: GuideFact = {
        kind: 'cardCreated',
        ...context.factBase(),
        scope: card.scope,
        cardId: card.cardId,
        cardKind: card.cardKind
      }
      context.emit(fact)
    },
    onCardSelected(card) {
      if (!accepts(card.scope) || card.cardId.length === 0) return
      if (!TRACKED_CARD_KINDS.has(card.cardKind)) return
      const fact: GuideFact = {
        kind: 'cardSelected',
        ...context.factBase(),
        scope: card.scope,
        cardId: card.cardId,
        cardKind: card.cardKind
      }
      context.emit(fact)
    },
    onCardDeleted(card) {
      if (!accepts(card.scope) || card.cardId.length === 0) return
      if (!TRACKED_CARD_KINDS.has(card.cardKind)) return
      const fact: GuideFact = {
        kind: 'cardDeleted',
        ...context.factBase(),
        scope: card.scope,
        cardId: card.cardId,
        cardKind: card.cardKind
      }
      context.emit(fact)
    },
    onDocumentOpened(event) {
      if (!accepts(event.scope) || event.cardId.length === 0) return
      context.emit({
        kind: 'documentOpened',
        ...context.factBase(),
        scope: event.scope,
        cardId: event.cardId
      })
    },
    onDocumentClosed(event) {
      if (!accepts(event.scope) || event.cardId.length === 0) return
      context.emit({
        kind: 'documentClosed',
        ...context.factBase(),
        scope: event.scope,
        cardId: event.cardId
      })
    },
    onCardEdited(event) {
      if (!accepts(event.scope)) return
      if (event.cardId.length === 0 || !ASSET_CARD_KINDS.has(event.cardKind)) return
      context.emit({
        kind: 'cardEdited',
        ...context.factBase(),
        scope: event.scope,
        cardId: event.cardId,
        cardKind: event.cardKind
      })
    },
    onPromptBodySaved(event) {
      if (!accepts(event.scope) || event.cardId.length === 0) return
      context.emit({
        kind: 'promptBodySaved',
        ...context.factBase(),
        scope: event.scope,
        cardId: event.cardId
      })
    },
    onRelationCreated(event) {
      emitRelation('relationCreated', event)
    },
    onRelationNamed(event) {
      emitRelation('relationNamed', event)
    },
    onRelationDeleted(event) {
      emitRelation('relationDeleted', event)
    },
    onCanvasSaved(event) {
      if (!accepts(event.scope)) return
      context.emit({
        kind: 'canvasSaved',
        ...context.factBase(),
        scope: event.scope,
        reason: 'manual'
      })
    },
    onInputSummaryOpened(event) {
      if (!accepts(event.scope)) return
      context.emit({
        kind: 'inputSummaryOpened',
        ...context.factBase(),
        scope: event.scope
      })
    }
  }
}
