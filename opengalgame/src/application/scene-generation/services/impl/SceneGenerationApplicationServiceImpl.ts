import type {
  ForkSceneGenerationDTO,
  GenerateSceneDTO,
  ReplySceneGenerationInteractionDTO,
  RetrySceneGenerationRepairDTO,
  SceneGenerationScopeDTO
} from '../../dto/SceneGenerationDTO'
import type {
  SceneGenerationOperationVO,
  SceneGenerationReplyReceiptVO,
  SceneGenerationStatusVO
} from '../../vo/SceneGenerationVO'
import type { SceneGenerationApplicationService } from '../SceneGenerationApplicationService'
import { CancelSceneGenerationUseCase } from './CancelSceneGenerationUseCase'
import { ForkSceneGenerationUseCase } from './ForkSceneGenerationUseCase'
import { GenerateSceneUseCase } from './GenerateSceneUseCase'
import { ReplySceneGenerationInteractionUseCase } from './ReplySceneGenerationInteractionUseCase'
import { ResumeAuthorizedPauseUseCase } from './ResumeAuthorizedPauseUseCase'
import { ResumeSceneGenerationUseCase } from './ResumeSceneGenerationUseCase'
import { RetryFailedRepairUseCase } from './RetryFailedRepairUseCase'
import type {
  SceneGenerationCoordinator,
  SceneGenerationDependencies
} from './SceneGenerationCoordinator'
import type { SceneGenerationServiceContext } from './SceneGenerationServiceContext'

export class SceneGenerationApplicationServiceImpl implements SceneGenerationApplicationService {
  private readonly generate: GenerateSceneUseCase
  private readonly retryFailed: RetryFailedRepairUseCase
  private readonly cancel: CancelSceneGenerationUseCase
  private readonly reply: ReplySceneGenerationInteractionUseCase
  private readonly resume: ResumeSceneGenerationUseCase
  private readonly resumeAuthorized: ResumeAuthorizedPauseUseCase
  private readonly fork: ForkSceneGenerationUseCase

  constructor(
    deps: SceneGenerationDependencies,
    coordinator: SceneGenerationCoordinator
  ) {
    const context: SceneGenerationServiceContext = { deps, coordinator }
    this.generate = new GenerateSceneUseCase(context)
    this.retryFailed = new RetryFailedRepairUseCase(context)
    this.cancel = new CancelSceneGenerationUseCase(context)
    this.reply = new ReplySceneGenerationInteractionUseCase(context)
    this.resume = new ResumeSceneGenerationUseCase(context)
    this.resumeAuthorized = new ResumeAuthorizedPauseUseCase(context)
    this.fork = new ForkSceneGenerationUseCase(context)
  }

  generateScene(request: GenerateSceneDTO): Promise<SceneGenerationOperationVO> {
    return this.generate.generateScene(request)
  }

  retryFailedRepair(
    request: RetrySceneGenerationRepairDTO & { operationId: string }
  ): Promise<SceneGenerationOperationVO> {
    return this.retryFailed.retryFailedRepair(request)
  }

  async cancelSceneGeneration(
    request: SceneGenerationScopeDTO
  ): Promise<SceneGenerationStatusVO> {
    return this.cancel.cancelSceneGeneration(request)
  }

  async replySceneGenerationInteraction(
    request: ReplySceneGenerationInteractionDTO
  ): Promise<SceneGenerationReplyReceiptVO> {
    return this.reply.replySceneGenerationInteraction(request)
  }

  resumeSceneGeneration(
    request: SceneGenerationScopeDTO
  ): Promise<SceneGenerationStatusVO> {
    return this.resume.resumeSceneGeneration(request)
  }

  resumeAuthorizedPause(
    request: SceneGenerationScopeDTO
  ): Promise<SceneGenerationStatusVO> {
    return this.resumeAuthorized.resumeAuthorizedPause(request)
  }

  forkSceneGeneration(
    request: ForkSceneGenerationDTO
  ): Promise<SceneGenerationOperationVO> {
    return this.fork.forkSceneGeneration(request)
  }
}
