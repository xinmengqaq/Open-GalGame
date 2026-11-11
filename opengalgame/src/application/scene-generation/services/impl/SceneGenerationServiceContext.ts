import type { SceneGenerationCoordinator, SceneGenerationDependencies } from './SceneGenerationCoordinator'

/** 用例共享依赖：端口集合与协调器。不保存请求级状态。 */
export interface SceneGenerationServiceContext {
  readonly deps: SceneGenerationDependencies
  readonly coordinator: SceneGenerationCoordinator
}
