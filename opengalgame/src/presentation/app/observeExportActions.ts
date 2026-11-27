import type {
  ExportFailedAction,
  ExportedAction,
  WorkbenchExportActionObservers
} from '@presentation/features/workbench-session/exportActionObservers'
import type { WorkbenchActionScope } from '@presentation/features/workbench-session/actionObserverScope'
import type { GuideActionFactContext } from './guideActionFactContext'

function acceptsExportScope(context: GuideActionFactContext, scope: WorkbenchActionScope): boolean {
  if (!context.active()) return false
  if (!scope.projectId || !scope.sceneId || !scope.canvasId) return false
  const current = context.readCurrent()
  return (
    current.page === 'workbench' &&
    current.projectId === scope.projectId &&
    current.sceneId === scope.sceneId &&
    current.canvasId === scope.canvasId
  )
}

/** 每次真实导出成功只转成一条事实；失败、停止或取消不会走到这里。 */
export function createExportActionObservation(
  context: GuideActionFactContext
): WorkbenchExportActionObservers {
  return {
    onExported(event: ExportedAction): void {
      if (!acceptsExportScope(context, event.scope) || event.outcome !== 'confirmed') return
      context.emit({
        kind: 'exported',
        ...context.factBase(),
        scope: event.scope,
        sceneId: event.scope.sceneId,
        outcome: 'confirmed'
      })
    },
    onExportFailed(event: ExportFailedAction): void {
      if (!acceptsExportScope(context, event.scope) || event.outcome !== 'failed') return
      const base = context.factBase()
      context.emit({
        kind: 'exportFailed',
        ...base,
        scope: event.scope,
        outcome: 'failed'
      })
    }
  }
}
