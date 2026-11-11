import type { SceneCanvasArrangementVO } from '../vo/SceneCanvasArrangementVO'

/** 按业务身份读写整份编排。不接受路径，不暴露持久化格式。 */
export interface SceneCanvasArrangementPersistenceGateway {
  /**
   * @returns 已保存编排；确认不存在时为 null。
   * @throws {AppException} 编排损坏、格式不支持、归属不匹配或读取失败。
   */
  readArrangement(
    projectId: string,
    sceneId: string,
    canvasId: string
  ): Promise<SceneCanvasArrangementVO | null>

  /**
   * @throws {AppException} 路径越界或写入失败。失败不得留下半份目标文件。
   */
  writeArrangement(arrangement: SceneCanvasArrangementVO): Promise<void>
}
