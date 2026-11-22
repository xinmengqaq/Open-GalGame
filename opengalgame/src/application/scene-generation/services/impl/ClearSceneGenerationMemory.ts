import type { SceneGenerationThreadDTO } from '../../dto/SceneGenerationDTO'
import type { ClearSceneGenerationMemoryVO } from '../../vo/SceneGenerationVO'
import { threadKey } from '../../policies/SceneGenerationIdempotency'

import type { SceneGenerationMemoryService } from '../SceneGenerationMemoryService'
import {
  SceneGenerationCoordinator,
  type SceneGenerationDependencies
} from './SceneGenerationCoordinator'
export class ClearSceneGenerationMemory implements SceneGenerationMemoryService {
  constructor(
    private readonly deps: SceneGenerationDependencies,
    private readonly coordinator: SceneGenerationCoordinator
  ) {}
  clearSceneGenerationMemory(
    request: SceneGenerationThreadDTO
  ): Promise<ClearSceneGenerationMemoryVO> {
    return this.coordinator.serialize(threadKey(request), async () => {
      await this.coordinator.requireIdleThread(request)
      await this.deps.memory.clearMemory(request)
      return { threadId: request.threadId, cleared: true }
    })
  }
}
