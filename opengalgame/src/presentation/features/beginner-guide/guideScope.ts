import type {
  GuideContextSnapshot,
  GuideFact,
  GuideScope,
  GuideScopeContext
} from './guideObservation'

/** 便于 app/会话把页面快照直接转成 reducer 需要的上下文。 */
export function guideScopeFromSnapshot(snapshot: GuideContextSnapshot): GuideScopeContext {
  return {
    projectId: snapshot.projectId,
    sceneId: snapshot.sceneId,
    canvasId: snapshot.canvasId
  }
}

export function factMatchesScope(scope: GuideScopeContext, fact: GuideFact): boolean {
  if (fact.kind === 'configTested' || fact.kind === 'configSaved') return true
  if (
    fact.scope.projectId !== null &&
    scope.projectId !== null &&
    fact.scope.projectId !== scope.projectId
  ) {
    return false
  }
  if (
    fact.scope.sceneId !== null &&
    fact.scope.sceneId !== undefined &&
    scope.sceneId !== null &&
    fact.scope.sceneId !== scope.sceneId
  ) {
    return false
  }
  if (
    fact.scope.canvasId !== null &&
    fact.scope.canvasId !== undefined &&
    scope.canvasId !== null &&
    fact.scope.canvasId !== scope.canvasId
  ) {
    return false
  }
  return true
}

/** 步骤 5/6 的生成与候选结果；只能归属到已经绑定工程、场景和画布的练习。 */
export function isPracticeGenerationFact(fact: GuideFact): boolean {
  switch (fact.kind) {
    case 'generationStarted':
    case 'generationFailed':
    case 'candidateReady':
    case 'candidateOpened':
    case 'candidateReturned':
    case 'candidateAccepted':
    case 'candidateRevised':
    case 'candidateDiscarded':
      return true
    default:
      return false
  }
}

/**
 * 事实是否属于当前练习。生成/候选事实不参与建立绑定：练习未绑定到具体工程、
 * 场景和画布时直接拒绝；已绑定时也必须与发起 scope 一致。建工程、进入工程等
 * 其他事实仍按 `factMatchesScope` 处理，保留建立绑定所需的事实。
 */
export function factBelongsToPractice(scope: GuideScopeContext, fact: GuideFact): boolean {
  if (!isPracticeGenerationFact(fact)) return factMatchesScope(scope, fact)
  if (scope.projectId === null || scope.sceneId === null) return false
  if (fact.scope.projectId !== scope.projectId) return false
  if (fact.scope.sceneId === undefined || fact.scope.sceneId === null) return false
  if (fact.scope.sceneId !== scope.sceneId) return false
  if (scope.canvasId === null) return false
  return (
    fact.scope.canvasId === undefined ||
    fact.scope.canvasId === null ||
    fact.scope.canvasId === scope.canvasId
  )
}

/** 只有建工程/进入工程等明确事实可以建立或推进工程绑定；其他结果事实只读。 */
export function factEstablishesScope(fact: GuideFact): boolean {
  return fact.kind === 'projectCreated' || fact.kind === 'projectEntered'
}

export function isMeaningfulScopeChange(
  current: GuideScopeContext,
  next: GuideScopeContext
): boolean {
  // 只有场景真正绑定后才因离开/换工程、换场景暂停。步骤 1/2 的首页快照可能
  // 只有工程或完全为空，离开项目页不应因此误暂停。不同工程之间仍算切换。
  if (
    current.projectId !== null &&
    next.projectId !== null &&
    current.projectId !== next.projectId
  ) {
    return true
  }
  if (current.sceneId === null) return false
  return current.sceneId !== next.sceneId
}

export function mergeScope(current: GuideScopeContext, next: GuideScope): GuideScopeContext {
  return {
    projectId: next.projectId ?? current.projectId,
    sceneId: next.sceneId ?? current.sceneId ?? null,
    canvasId: next.canvasId ?? current.canvasId ?? null
  }
}

export function copyScope(scope: GuideScopeContext): GuideScopeContext {
  return {
    projectId: scope.projectId,
    sceneId: scope.sceneId,
    canvasId: scope.canvasId
  }
}

/**
 * 「在此继续」的恢复目标。只有带 projectId 的真实工程快照才能作为新目标；
 * 项目页/首页等无绑定页面不是另一个工程，保留暂停前的工程，避免把暂停队列
 * 当成换工程重排。同一工程缺场景时也先保留原场景，等真实切场景再重排。
 * 依据：设计「切换工程或场景时暂停原来的跟随，由用户在新上下文选择恢复」。
 */
export function resumeGuideScope(
  current: GuideScopeContext,
  pending: GuideScopeContext | null,
  requested: GuideScopeContext | undefined
): GuideScopeContext {
  const candidate = requested?.projectId
    ? requested
    : pending?.projectId
      ? pending
      : null
  if (!candidate) return copyScope(current)
  if (candidate.projectId !== current.projectId) return copyScope(candidate)
  return {
    projectId: candidate.projectId,
    sceneId: candidate.sceneId ?? current.sceneId,
    canvasId: candidate.canvasId ?? current.canvasId
  }
}
