import type {
  CloseSceneGenerationCandidatePreviewDTO,
  ListSceneGenerationHistoryForSceneDTO,
  OpenSceneGenerationCandidatePreviewDTO,
  ReadSceneGenerationCheckpointDTO,
  ReplySceneGenerationInteractionDTO,
  ResumeSceneGenerationDTO,
  RetrySceneGenerationRepairDTO,
  SceneGenerationScopeDTO,
  StartSceneGenerationDTO
} from '@application/scene-generation/dto/SceneGenerationDTO'
import type {
  SceneGenerationCandidatePreviewVO,
  SceneGenerationHistorySummaryVO,
  SceneGenerationRenderProgressEventVO,
  SceneGenerationRenderStatusVO
} from '@application/scene-generation/vo/SceneGenerationRenderVO'
import type { AjaxResult } from '@common/contracts/AjaxResult'
import { ErrorCodes } from '@common/errors/ErrorCodes'
import { communicationFailureResult } from '../../client/communicationFailure'
import type { DesktopBridge } from '../../client/DesktopBridge'
import {
  parseSceneGenerationCheckpointResult,
  parseSceneGenerationHistoryResult,
  parseSceneGenerationNullResult,
  parseSceneGenerationPreviewResult,
  parseSceneGenerationStatusResult
} from '../contracts/SceneGenerationResponseSchema'
import type { SceneGenerationClient, SceneGenerationProgressScope } from './SceneGenerationClient'

const progressSubscriptionFailureMessage = '进度订阅未建立，正在用状态刷新。'

/**
 * 最近一次操作可能不存在：先按 null 结果解析，再按完整渲染状态校验；
 * 两种成功响应互斥，失败响应由 null 解析统一接住。
 */
function parseLatestSceneGenerationResult(
  value: unknown
): AjaxResult<SceneGenerationRenderStatusVO | null> | null {
  const empty = parseSceneGenerationNullResult(value)
  if (empty) return empty
  return parseSceneGenerationStatusResult(value)
}

async function readGenerationResult<T>(
  action: () => Promise<unknown>,
  parse: (value: unknown) => AjaxResult<T> | null
): Promise<AjaxResult<T>> {
  try {
    return parse(await action()) ?? communicationFailureResult()
  } catch {
    return communicationFailureResult()
  }
}

export class SceneGenerationClientImpl implements SceneGenerationClient {
  /**
   * @param bridge - 与主进程通信的固定桥接。
   */
  constructor(private readonly bridge: DesktopBridge) {}

  start(request: StartSceneGenerationDTO): Promise<AjaxResult<SceneGenerationRenderStatusVO>> {
    return readGenerationResult(
      () => this.bridge.startSceneGeneration(request),
      parseSceneGenerationStatusResult
    )
  }

  retryRepair(
    request: RetrySceneGenerationRepairDTO
  ): Promise<AjaxResult<SceneGenerationRenderStatusVO>> {
    return readGenerationResult(
      () => this.bridge.retrySceneGenerationRepair(request),
      parseSceneGenerationStatusResult
    )
  }

  status(request: SceneGenerationScopeDTO): Promise<AjaxResult<SceneGenerationRenderStatusVO>> {
    return readGenerationResult(
      () => this.bridge.getSceneGenerationStatus(request),
      parseSceneGenerationStatusResult
    )
  }

  latest(request: {
    projectId: string
    sceneId: string
  }): Promise<AjaxResult<SceneGenerationRenderStatusVO | null>> {
    return readGenerationResult(
      () => this.bridge.getLatestSceneGeneration(request),
      parseLatestSceneGenerationResult
    )
  }

  reply(
    request: ReplySceneGenerationInteractionDTO
  ): Promise<AjaxResult<SceneGenerationRenderStatusVO>> {
    return readGenerationResult(
      () => this.bridge.replySceneGeneration(request),
      parseSceneGenerationStatusResult
    )
  }

  pause(request: SceneGenerationScopeDTO): Promise<AjaxResult<SceneGenerationRenderStatusVO>> {
    return readGenerationResult(
      () => this.bridge.pauseSceneGeneration(request),
      parseSceneGenerationStatusResult
    )
  }

  resume(request: ResumeSceneGenerationDTO): Promise<AjaxResult<SceneGenerationRenderStatusVO>> {
    return readGenerationResult(
      () => this.bridge.resumeSceneGeneration(request),
      parseSceneGenerationStatusResult
    )
  }

  cancel(request: SceneGenerationScopeDTO): Promise<AjaxResult<SceneGenerationRenderStatusVO>> {
    return readGenerationResult(
      () => this.bridge.cancelSceneGeneration(request),
      parseSceneGenerationStatusResult
    )
  }

  listHistory(
    request: ListSceneGenerationHistoryForSceneDTO
  ): Promise<AjaxResult<readonly SceneGenerationHistorySummaryVO[]>> {
    return readGenerationResult(
      () => this.bridge.listSceneGenerationHistory(request),
      parseSceneGenerationHistoryResult
    )
  }

  readCheckpoint(
    request: ReadSceneGenerationCheckpointDTO
  ): Promise<AjaxResult<SceneGenerationHistorySummaryVO>> {
    return readGenerationResult(
      () => this.bridge.readSceneGenerationCheckpoint(request),
      parseSceneGenerationCheckpointResult
    )
  }

  openPreview(
    request: OpenSceneGenerationCandidatePreviewDTO
  ): Promise<AjaxResult<SceneGenerationCandidatePreviewVO>> {
    return readGenerationResult(
      () => this.bridge.openSceneGenerationPreview(request),
      parseSceneGenerationPreviewResult
    )
  }

  closePreview(request: CloseSceneGenerationCandidatePreviewDTO): Promise<AjaxResult<null>> {
    return readGenerationResult(
      () => this.bridge.closeSceneGenerationPreview(request),
      parseSceneGenerationNullResult
    )
  }

  subscribeProgress(
    scope: SceneGenerationProgressScope,
    listener: (event: SceneGenerationRenderProgressEventVO) => void,
    onError?: (message: string) => void
  ): () => void {
    const seen = new Set<number>()
    let active = true
    const reportFailure = (): void => {
      if (active) onError?.(progressSubscriptionFailureMessage)
    }
    const stopListening = this.bridge.onSceneGenerationProgress((event) => {
      if (
        event.projectId !== scope.projectId ||
        event.sceneId !== scope.sceneId ||
        event.operationId !== scope.operationId ||
        event.threadId !== scope.threadId ||
        event.branchId !== scope.branchId ||
        seen.has(event.sequence)
      ) {
        return
      }
      seen.add(event.sequence)
      listener(event)
    })
    try {
      void this.bridge
        .subscribeSceneGenerationProgress({
          projectId: scope.projectId,
          sceneId: scope.sceneId,
          operationId: scope.operationId,
          threadId: scope.threadId,
          branchId: scope.branchId
        })
        .then((result) => {
          if (result.code !== ErrorCodes.success) reportFailure()
        })
        .catch(reportFailure)
    } catch {
      reportFailure()
    }
    return () => {
      active = false
      stopListening()
    }
  }

  reconnect(request: SceneGenerationScopeDTO): Promise<AjaxResult<SceneGenerationRenderStatusVO>> {
    return this.status(request)
  }
}
