import type { WorkbenchActionScope } from './actionObserverScope'

/** 开始生成已被接受，且启动前的画布保存已确认。 */
export type GenerationStartedAction = {
  scope: WorkbenchActionScope
  operationId: string
  saveVerified: true
}

/** 审阅候选已就绪，预览可用；每个候选只应上报一次。 */
export type CandidateReadyAction = {
  scope: WorkbenchActionScope
  candidateSnapshotId: string
  operationId: string
  previewAvailable: true
}

/** 生成已确认终止失败；启动失败、待核对和取消不走上报。 */
export type GenerationFailedAction = {
  scope: WorkbenchActionScope
  operationId: string
  outcome: 'confirmed'
}

export type CandidateOpenedAction = {
  scope: WorkbenchActionScope
  candidateSnapshotId: string
}

export type CandidateReturnedAction = {
  scope: WorkbenchActionScope
  candidateSnapshotId: string
}

export type CandidateAcceptedAction = {
  scope: WorkbenchActionScope
  operationId: string
  candidateSnapshotId: string
  outcome: 'confirmed'
}

export type CandidateRevisedAction = {
  scope: WorkbenchActionScope
  candidateSnapshotId: string
  operationId: string
}

export type CandidateDiscardedAction = {
  scope: WorkbenchActionScope
  candidateSnapshotId: string
  outcome: 'confirmed'
}

/**
 * 生成与候选的窄语义动作。
 *
 * 页面只在业务确认点调用这些回调；scope 是动作发生时捕获的当前工程/场景/画布。
 * 回调不携带候选正文、剧本内容、路径或导出产物。
 */
export interface WorkbenchGenerationActionObservers {
  onGenerationStarted?: (event: GenerationStartedAction) => void
  onGenerationFailed?: (event: GenerationFailedAction) => void
  onCandidateReady?: (event: CandidateReadyAction) => void
  onCandidateOpened?: (event: CandidateOpenedAction) => void
  onCandidateReturned?: (event: CandidateReturnedAction) => void
  onCandidateAccepted?: (event: CandidateAcceptedAction) => void
  onCandidateRevised?: (event: CandidateRevisedAction) => void
  onCandidateDiscarded?: (event: CandidateDiscardedAction) => void
}
