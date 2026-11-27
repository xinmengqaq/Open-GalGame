import type {
  DialogueDraftChangedAction,
  DialogueSaveClearedAction,
  DialogueSaveStartedAction,
  DialogueSavedAction,
  DialogueSaveUnsettledAction,
  WorkbenchPreviewActionObservers
} from '@presentation/features/workbench-session/previewActionObservers'
import type { WorkbenchActionScope } from '@presentation/features/workbench-session/actionObserverScope'
import type { GuideActionFactContext } from './guideActionFactContext'

function acceptsPreviewScope(
  context: GuideActionFactContext,
  scope: WorkbenchActionScope
): boolean {
  if (!context.active()) return false
  const current = context.readCurrent()
  return (
    current.page === 'workbench' &&
    current.projectId === scope.projectId &&
    current.sceneId === scope.sceneId &&
    current.canvasId === scope.canvasId
  )
}

/** 只把直接保存成功（“已保存”）的预览动作转成事实，同一 requestId 只发一次。 */
export function createPreviewActionObservation(
  context: GuideActionFactContext
): WorkbenchPreviewActionObservers {
  const publishedRequests = new Set<string>()

  return {
    onDialogueSaveStarted(event: DialogueSaveStartedAction): void {
      if (!acceptsPreviewScope(context, event.scope) || event.requestId.length === 0) return
      context.emit({
        kind: 'dialogueSaveStarted',
        ...context.factBase(),
        scope: event.scope,
        requestId: event.requestId,
        outcome: 'confirmed'
      })
    },
    onDialogueSaved(event: DialogueSavedAction): void {
      if (
        !acceptsPreviewScope(context, event.scope) ||
        event.requestId.length === 0 ||
        !Number.isFinite(event.revision) ||
        event.outcome !== 'confirmed'
      ) {
        return
      }
      const key = `${event.scope.projectId}|${event.scope.sceneId}|${event.requestId}`
      if (publishedRequests.has(key)) return
      publishedRequests.add(key)
      context.emit({
        kind: 'dialogueSaved',
        ...context.factBase(),
        scope: event.scope,
        requestId: event.requestId,
        revision: event.revision,
        outcome: 'confirmed'
      })
    },
    onDialogueSaveUnsettled(event: DialogueSaveUnsettledAction): void {
      if (!acceptsPreviewScope(context, event.scope)) return
      if (event.requestId !== undefined && event.requestId.length === 0) return
      const base = context.factBase()
      context.emit({
        kind: 'dialogueSaveUnsettled',
        ...base,
        scope: event.scope,
        ...(event.requestId === undefined ? {} : { requestId: event.requestId }),
        outcome: event.outcome
      })
    },
    onDialogueDraftChanged(event: DialogueDraftChangedAction): void {
      if (!acceptsPreviewScope(context, event.scope)) return
      context.emit({
        kind: 'dialogueDraftChanged',
        ...context.factBase(),
        scope: event.scope,
        dirty: event.dirty,
        outcome: 'confirmed'
      })
    },
    onDialogueSaveCleared(event: DialogueSaveClearedAction): void {
      if (!acceptsPreviewScope(context, event.scope)) return
      if (event.requestId !== undefined && event.requestId.length === 0) return
      context.emit({
        kind: 'dialogueSaveCleared',
        ...context.factBase(),
        scope: event.scope,
        ...(event.requestId === undefined ? {} : { requestId: event.requestId }),
        clearReason: event.reason,
        outcome: 'confirmed'
      })
    }
  }
}
