import type {
  SceneCanvasArrangementVersion,
  SceneCanvasVersionKeepRequest,
  SceneCanvasVersionSettlement
} from '../models/SceneCanvasSaveFacts'

/**
 * 作品版本窄端口。
 * 只请求提交和结算核对。没有可靠作品结算时不得返回已保持。
 */
export interface SceneCanvasWorkVersionGateway {
  /**
   * 请求保持当前场景编排的作品版本状态。
   * @throws {AppException} 端口无法完成调用时由应用层按结果不明处理。
   */
  keepArrangement(request: SceneCanvasVersionKeepRequest): Promise<SceneCanvasVersionSettlement>

  /**
   * 按调用方保留的操作标识读取结算。
   * 该标识不是版本身份。对不上时保持不明，调用方不得直接重提。
   */
  readSettlement(operationId: string): Promise<SceneCanvasVersionSettlement>

  /**
   * 读取已保持编排的后端版本事实。
   * 文件缺失、摘要不可用或版本事实不明时必须拒绝，不能返回猜测版本。
   */
  readArrangementVersion(
    request: Pick<SceneCanvasArrangementVersion, 'projectId' | 'sceneId' | 'canvasId'>
  ): Promise<SceneCanvasArrangementVersion>
}
