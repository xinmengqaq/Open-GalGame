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
  type GenerationProgressStep
} from './generationPresentation'
import {
  prepareGenerationWorkspace,
  useGenerationActions,
  WORKSPACE_NOT_READY_GENERATION_MESSAGE,
  type SaveCanvasOutcome
} from './useGenerationActions'
import { useGenerationDraft } from './useGenerationDraft'
import { useGenerationStatus, readGenerationHistory } from './useGenerationStatus'

export {
  prepareGenerationWorkspace,
  readGenerationHistory,
  WORKSPACE_NOT_READY_GENERATION_MESSAGE,
  type SaveCanvasOutcome
}

type UseSceneGenerationOptions = {
  projectClient: ProjectClient
  client: SceneGenerationClient
  projectId: string
  sceneId: string
  canvasId: string
  saveState: WorkbenchSaveState
  pageBlocked: boolean
  canvasReady: boolean
  saveCanvas: () => Promise<SaveCanvasOutcome>
}

export type SceneGenerationController = {
  status: SceneGenerationRenderStatusVO | null
  phase: GenerationPhase
  loading: boolean
  loadError: string | null
  unavailableReason: string | null
  pending: GenerationActionKind | null
  startPhase: 'saving' | 'preparing' | null
  actionError: GenerationActionFailure | null
  draft: GenerationDraft
  progress: readonly GenerationProgressStep[]
  /** 进度订阅失败等非阻断提示；不表示生成失败。 */
  progressNotice: string | null
  startBlockedReason: string | null
  start: () => Promise<void>
  submitPrimary: () => Promise<void>
  accept: () => Promise<void>
  discard: () => Promise<void>
  pause: () => Promise<void>
  resume: () => Promise<void>
  cancel: () => Promise<void>
  /** 非中断修复失败：携带已确认修改正文和上一候选来源发起新操作。 */
  retryRepair: () => Promise<void>
  selectOption: (optionId: string | null) => void
  selectAnswer: (questionId: string, optionId: string | null) => void
  setAnswerBody: (questionId: string, body: string) => void
  setBody: (body: string) => void
  reload: () => void
}

/**
 * 场景生成的页面级状态机。抽屉只消费这里的状态和动作；关闭抽屉不触发取消，
 * 订阅与任务状态随页面身份存活，重新打开通过 `reload` 重新核对后端事实。
 */
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
    saveCanvas
  } = options

  // 唯一实例：status 写入，draft/actions 只读；pending 由 actions 写入，status 只读。
  const statusRef = useRef<SceneGenerationRenderStatusVO | null>(null)
  const pendingRef = useRef<GenerationActionKind | null>(null)

  const draftEditing = useGenerationDraft({ statusRef })
  const status = useGenerationStatus({
    client,
    projectId,
    sceneId,
    statusRef,
    pendingRef,
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
    pendingRef
  })

  return {
    status: status.status,
    phase: generationPhaseOf(status.status),
    loading: status.loading,
    loadError: status.loadError,
    unavailableReason: status.unavailableReason,
    pending: actions.pending,
    startPhase: actions.startPhase,
    actionError: actions.actionError,
    draft,
    progress: status.progress,
    progressNotice: status.progressNotice,
    startBlockedReason: actions.startBlockedReason,
    start: actions.start,
    submitPrimary: actions.submitPrimary,
    accept: actions.accept,
    discard: actions.discard,
    pause: actions.pause,
    resume: actions.resume,
    cancel: actions.cancel,
    retryRepair: actions.retryRepair,
    selectOption: draftEditing.selectOption,
    selectAnswer: draftEditing.selectAnswer,
    setAnswerBody: draftEditing.setAnswerBody,
    setBody: draftEditing.setBody,
    reload: status.reload
  }
}
