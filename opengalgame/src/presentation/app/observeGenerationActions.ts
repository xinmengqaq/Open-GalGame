import type {
  CandidateAcceptedAction,
  CandidateDiscardedAction,
  CandidateOpenedAction,
  CandidateReadyAction,
  CandidateReturnedAction,
  CandidateRevisedAction,
  GenerationFailedAction,
  GenerationStartedAction,
  WorkbenchGenerationActionObservers
} from '@presentation/features/workbench-session/generationActionObservers'
import type { WorkbenchActionScope } from '@presentation/features/workbench-session/actionObserverScope'
import type { GuideActionFactContext } from './guideActionFactContext'

function scopeKey(scope: WorkbenchActionScope): string {
  return `${scope.projectId}|${scope.sceneId}|${scope.canvasId}`
}

const MAX_TRACKED_KEYS = 128

/**
 * 生命周期记录只用于忽略同一次业务结果的重复投递；超过上限时淘汰最早键，
 * 避免长时间会话无界增长。打开/返回是可循环事件，不进入这里。
 */
function rememberKey(keys: Set<string>, key: string): boolean {
  if (keys.has(key)) return false
  keys.add(key)
  if (keys.size > MAX_TRACKED_KEYS) {
    const oldest = keys.values().next().value
    if (oldest !== undefined) keys.delete(oldest)
  }
  return true
}

/**
 * 把生成/候选页面的窄回调翻译成 GuideFact。
 *
 * 只接收页面在业务确认点上报的动作；这里再做作用域、字段和幂等校验，避免旧工程、
 * 旧场景、重复通知或缺少成功依据的动作进入指引。
 */
export function createGenerationActionObservation(
  context: GuideActionFactContext
): WorkbenchGenerationActionObservers {
  const startedOperations = new Set<string>()
  const failedOperations = new Set<string>()
  const readyCandidates = new Set<string>()
  const acceptedCandidates = new Set<string>()
  const revisedCandidates = new Set<string>()
  const discardedCandidates = new Set<string>()

  /** 只检查教程是否在跟做；工程/场景归属由会话按练习绑定判断。 */
  function active(): boolean {
    return context.active()
  }

  function candidateKey(scope: WorkbenchActionScope, candidateSnapshotId: string): string {
    return `${scopeKey(scope)}|${candidateSnapshotId}`
  }

  function onGenerationStarted(event: GenerationStartedAction): void {
    if (!active() || event.operationId.length === 0 || event.saveVerified !== true) {
      return
    }
    const key = `${scopeKey(event.scope)}|${event.operationId}`
    if (!rememberKey(startedOperations, key)) return
    context.emit({
      kind: 'generationStarted',
      ...context.factBase(),
      scope: event.scope,
      operationId: event.operationId,
      saveVerified: true
    })
  }

  function onGenerationFailed(event: GenerationFailedAction): void {
    if (
      !active() ||
      event.operationId.length === 0 ||
      event.outcome !== 'confirmed'
    ) {
      return
    }
    const key = `${scopeKey(event.scope)}|${event.operationId}`
    if (!rememberKey(failedOperations, key)) return
    context.emit({
      kind: 'generationFailed',
      ...context.factBase(),
      scope: event.scope,
      operationId: event.operationId
    })
  }

  function onCandidateReady(event: CandidateReadyAction): void {
    if (
      !active() ||
      event.candidateSnapshotId.length === 0 ||
      event.operationId.length === 0 ||
      event.previewAvailable !== true
    ) {
      return
    }
    const key = candidateKey(event.scope, event.candidateSnapshotId)
    if (!rememberKey(readyCandidates, key)) return
    context.emit({
      kind: 'candidateReady',
      ...context.factBase(),
      scope: event.scope,
      candidateSnapshotId: event.candidateSnapshotId,
      operationId: event.operationId,
      previewAvailable: true
    })
  }

  function onCandidateOpened(event: CandidateOpenedAction): void {
    if (!active() || event.candidateSnapshotId.length === 0) return
    context.emit({
      kind: 'candidateOpened',
      ...context.factBase(),
      scope: event.scope,
      candidateSnapshotId: event.candidateSnapshotId
    })
  }

  function onCandidateReturned(event: CandidateReturnedAction): void {
    if (!active() || event.candidateSnapshotId.length === 0) return
    context.emit({
      kind: 'candidateReturned',
      ...context.factBase(),
      scope: event.scope,
      candidateSnapshotId: event.candidateSnapshotId
    })
  }

  function onCandidateAccepted(event: CandidateAcceptedAction): void {
    if (!active() || event.outcome !== 'confirmed') return
    if (
      typeof event.operationId !== 'string' ||
      event.operationId.length === 0 ||
      typeof event.candidateSnapshotId !== 'string' ||
      event.candidateSnapshotId.length === 0
    ) {
      return
    }
    const key = `${scopeKey(event.scope)}|${event.operationId}|${event.candidateSnapshotId}`
    if (!rememberKey(acceptedCandidates, key)) return
    context.emit({
      kind: 'candidateAccepted',
      ...context.factBase(),
      scope: event.scope,
      operationId: event.operationId,
      candidateSnapshotId: event.candidateSnapshotId
    })
  }

  function onCandidateRevised(event: CandidateRevisedAction): void {
    if (
      !active() ||
      event.candidateSnapshotId.length === 0 ||
      event.operationId.length === 0
    ) {
      return
    }
    const key = candidateKey(event.scope, event.candidateSnapshotId)
    if (!rememberKey(revisedCandidates, key)) return
    context.emit({
      kind: 'candidateRevised',
      ...context.factBase(),
      scope: event.scope,
      candidateSnapshotId: event.candidateSnapshotId,
      operationId: event.operationId
    })
  }

  function onCandidateDiscarded(event: CandidateDiscardedAction): void {
    if (
      !active() ||
      event.candidateSnapshotId.length === 0 ||
      event.outcome !== 'confirmed'
    ) {
      return
    }
    const key = candidateKey(event.scope, event.candidateSnapshotId)
    if (!rememberKey(discardedCandidates, key)) return
    context.emit({
      kind: 'candidateDiscarded',
      ...context.factBase(),
      scope: event.scope,
      candidateSnapshotId: event.candidateSnapshotId
    })
  }

  return {
    onGenerationStarted,
    onGenerationFailed,
    onCandidateReady,
    onCandidateOpened,
    onCandidateReturned,
    onCandidateAccepted,
    onCandidateRevised,
    onCandidateDiscarded
  }
}
