import type { ReadSceneSourceRequest, SceneSourceSnapshot } from '../models/SceneSourceSnapshot'

export interface SceneSourceReaderGateway {
  readSceneSource(request: ReadSceneSourceRequest): Promise<SceneSourceSnapshot>
}
