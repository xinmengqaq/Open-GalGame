import type { SceneGenerationThreadDTO } from '../../dto/SceneGenerationDTO'
import type { ClearSceneGenerationMemoryVO } from '../../vo/SceneGenerationVO'
import { threadKey } from '../../policies/SceneGenerationIdempotency'

import type { SceneGenerationMemoryService } from '../SceneGenerationMemoryService'
import {
  SceneGenerationCoordinator,
  type SceneGenerationDependencies
} from './SceneGenerationCoordinator'
export class SceneGenerationMemoryServiceImpl implements SceneGenerationMemoryService {
  constructor(
    private readonly deps: SceneGenerationDependencies,
    private readonly coordinator: SceneGenerationCoordinator
  ) {}
  /**
   * 线程无运行、等待或待恢复操作时清理其本机记忆。
   * @throws {AppException} 线程仍有未结束操作或记忆清理失败。
   */
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
