import { useRef } from 'react'

import type { SceneGenerationRenderStatusVO } from '@application/scene-generation/vo/SceneGenerationRenderVO'
import type { ProjectClient } from '@interfaces/client/ProjectClient'
import type { SceneGenerationClient } from '@interfaces/scene-generation/client/SceneGenerationClient'
import type { WorkbenchSaveState } from '@presentation/features/workbench-session/workbenchSession.types'

import {
  effectiveDraft,
  generationPhaseOf,
  type GenerationActionFailure,
  type GenerationActionKind,
  type GenerationDraft,
  type GenerationPhase,
  type GenerationProgressStep,
  type HistoryForkSource
} from './generationPresentation'
import {
  prepareGenerationWorkspace,
  useGenerationActions,
  WORKSPACE_NOT_READY_GENERATION_MESSAGE,
  type ForkFromHistoryOutcome,
  type SaveCanvasOutcome
} from './useGenerationActions'
import { useGenerationDraft } from './useGenerationDraft'
import {
  useGenerationStatus,
  readGenerationHistory,
  type GenerationDiscoveryRefreshResult
} from './useGenerationStatus'

export {
  prepareGenerationWorkspace,
  readGenerationHistory,
  WORKSPACE_NOT_READY_GENERATION_MESSAGE,
  type SaveCanvasOutcome
}

export type UseSceneGenerationOptions = {
  projectClient: ProjectClient
  client: SceneGenerationClient
  projectId: string
  sceneId: string
  canvasId: string
  saveState: WorkbenchSaveState
  pageBlocked: boolean
  canvasReady: boolean
  saveCanvas: () => Promise<SaveCanvasOutcome>
  onGenerationStarted?: (event: { operationId: string }) => void
  onCandidateAccepted?: (event: { operationId: string; candidateSnapshotId: string }) => void
  onCandidateRevised?: (event: { operationId: string; candidateSnapshotId: string }) => void
  onCandidateDiscarded?: (event: { operationId: string; candidateSnapshotId: string }) => void
}

export type SceneGenerationController = {
  status: SceneGenerationRenderStatusVO | null
  phase: GenerationPhase
  loading: boolean
  loadError: string | null
  unavailableReason: string | null
  /** 需要作者处理的操作（无检查点遗留或带检查点待核对）；只读，选择不会自动恢复。 */
  unfinished: readonly SceneGenerationRenderStatusVO[]
  pending: GenerationActionKind | null
  startPhase: 'saving' | 'preparing' | null
  actionError: GenerationActionFailure | null
  /** 启动结果因作者已切换视图而不能写回时的固定提示；不改变当前选择。 */
  startNotice: string | null
  draft: GenerationDraft
  progress: readonly GenerationProgressStep[]
  progressNotice: string | null
  /** 显式选择的任务已失效时的固定提示；缺失表示没有。 */
  selectionNotice: string | null
  startBlockedReason: string | null
  /** 启动是否被场景内已有生成挡住；只有该原因下显示 AI 历史处理入口。 */
  startBlockedByGeneration: boolean
  /** 修复重跑自己的禁用依据；不包含已有生成冲突。 */
  repairBlockedReason: string | null
  start: () => Promise<void>
  submitPrimary: () => Promise<void>
  accept: () => Promise<void>
  discard: () => Promise<void>
  pause: () => Promise<void>
  resume: () => Promise<void>
  resumeUnfinished: () => Promise<void>
  retryCleanup: () => Promise<void>
  verifyResult: () => Promise<void>
  cancel: () => Promise<void>
  retryRepair: () => Promise<void>
  /** 从 AI 历史创建新分支；成功时页面状态切到新操作。 */
  forkFromHistory: (source: HistoryForkSource) => Promise<ForkFromHistoryOutcome>
  selectOption: (optionId: string | null) => void
  selectAnswer: (questionId: string, optionId: string | null) => void
  setAnswerBody: (questionId: string, body: string) => void
  setBody: (body: string) => void
  reload: () => void
  /** 只重读未完成操作发现；返回可等待的完成/错误信号。 */
  refreshDiscovery: () => Promise<GenerationDiscoveryRefreshResult>
  /** 从历史发现列表切换当前操作；不恢复、不调用模型。 */
  selectUnfinished: (operationId: string) => boolean
}

export function useSceneGeneration(options: UseSceneGenerationOptions): SceneGenerationController {
  const {
    projectClient,
    client,
    projectId,
    sceneId,
    canvasId,
    saveState,
    pageBlocked,
    canvasReady,
    saveCanvas,
    onGenerationStarted,
    onCandidateAccepted,
    onCandidateRevised,
    onCandidateDiscarded
  } = options

  // 唯一实例：status 写入，draft/actions 只读；pending 由 actions 自己的请求登记表持有。
  const statusRef = useRef<SceneGenerationRenderStatusVO | null>(null)

  const draftEditing = useGenerationDraft({ statusRef })
  const status = useGenerationStatus({
    client,
    projectId,
    sceneId,
    statusRef,
    resetDraft: draftEditing.reset
  })
  const draft = effectiveDraft(status.status?.interaction, draftEditing.draftState)
  const actions = useGenerationActions({
    projectClient,
    client,
    projectId,
    sceneId,
    canvasId,
    saveState,
    pageBlocked,
    canvasReady,
    saveCanvas,
    status,
    draft,
    onGenerationStarted,
    onCandidateAccepted,
    onCandidateRevised,
    onCandidateDiscarded
  })

  return {
    status: status.status,
    phase: generationPhaseOf(status.status),
    loading: status.loading,
    loadError: status.loadError,
    unavailableReason: status.unavailableReason,
    unfinished: status.unfinished,
    pending: actions.pending,
    startPhase: actions.startPhase,
    actionError: actions.actionError,
    startNotice: actions.startNotice,
    draft,
    progress: status.progress,
    progressNotice: status.progressNotice,
    selectionNotice: status.selectionNotice,
    startBlockedReason: actions.startBlockedReason,
    startBlockedByGeneration: actions.startBlockedByGeneration,
    repairBlockedReason: actions.repairBlockedReason,
    start: actions.start,
    submitPrimary: actions.submitPrimary,
    accept: actions.accept,
    discard: actions.discard,
    pause: actions.pause,
    resume: actions.resume,
    resumeUnfinished: actions.resumeUnfinished,
    retryCleanup: actions.retryCleanup,
    verifyResult: actions.verifyResult,
    cancel: actions.cancel,
    retryRepair: actions.retryRepair,
    forkFromHistory: actions.forkFromHistory,
    selectOption: draftEditing.selectOption,
    selectAnswer: draftEditing.selectAnswer,
    setAnswerBody: draftEditing.setAnswerBody,
    setBody: draftEditing.setBody,
    reload: status.reload,
    refreshDiscovery: status.refreshDiscovery,
    selectUnfinished: status.selectUnfinished
  }
}
