import type { SceneGenerationScopeDTO } from '../../dto/SceneGenerationDTO'
import type { SceneGenerationStatusVO } from '../../vo/SceneGenerationVO'
import { resumeExecution } from './SceneGenerationResumeExecution'
import type { SceneGenerationServiceContext } from './SceneGenerationServiceContext'

export class ResumeAuthorizedPauseUseCase {
  constructor(private readonly context: SceneGenerationServiceContext) {}

  resumeAuthorizedPause(request: SceneGenerationScopeDTO): Promise<SceneGenerationStatusVO> {
    return resumeExecution(this.context, request, true)
  }
}
