import type { SceneGenerationCoordinator, SceneGenerationDependencies } from './SceneGenerationCoordinator'

export interface SceneGenerationServiceContext {
  readonly deps: SceneGenerationDependencies
  readonly coordinator: SceneGenerationCoordinator
}
