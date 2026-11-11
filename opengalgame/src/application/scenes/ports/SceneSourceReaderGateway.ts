import type { ReadSceneSourceRequest, SceneSourceSnapshot } from '../models/SceneSourceSnapshot'

export interface SceneSourceReaderGateway {
  /**
   * 读取正式工程或指定候选根内的同份源快照，不执行写入。
   * @throws {AppException} 路径、编码、读取故障或内容在读取中变化。
   */
  readSceneSource(request: ReadSceneSourceRequest): Promise<SceneSourceSnapshot>
}
