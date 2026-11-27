import type { GuideFact } from '../features/beginner-guide/guideObservation'
import type { ImportedSourceAction } from '../features/workbench-session/workbenchActionObservers'
import type { GuideActionFactContext } from './guideActionFactContext'

export interface InputActionObservation {
  onSourceImported(source: ImportedSourceAction): void
}

/**
 * 只在目录导入真实成功后被调用；失败、取消和提交未确认（COMMIT_UNCLEAR_CODE）
 * 都不会走到这里。只有文档来源发布事实：图片、音频、视频的导入结果没有任何
 * 步骤按来源 ID 匹配，发布它们只会占用目录/示例打开时的延迟队列。
 */
export function createInputActionObservation(
  context: GuideActionFactContext
): InputActionObservation {
  return {
    onSourceImported(source) {
      if (source.contentKind !== 'text') return
      if (!context.active()) return
      const snapshot = context.readCurrent()
      if (snapshot.page !== 'workbench' || snapshot.projectId !== source.projectId) return
      const fact: GuideFact = {
        kind: 'sourceImported',
        ...context.factBase(),
        scope: { projectId: source.projectId, sceneId: null, canvasId: null },
        sourceId: source.sourceId,
        sourceKind: 'document'
      }
      context.emit(fact)
    }
  }
}
