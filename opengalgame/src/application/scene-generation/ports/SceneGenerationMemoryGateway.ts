import type { SceneGenerationThreadDTO } from '../dto/SceneGenerationDTO'

export interface SceneGenerationMemoryGateway {
  clearMemory(scope: SceneGenerationThreadDTO): Promise<void>
}
