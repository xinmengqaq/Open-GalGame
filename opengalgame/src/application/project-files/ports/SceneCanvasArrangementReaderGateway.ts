import type { VerifiedProjectReadLocation } from '../models/ProjectInputSourceReadFacts'
import type { SceneCanvasArrangementInspectionFact } from '../models/SceneCanvasArrangementReadFacts'

export interface SceneCanvasArrangementReaderGateway {
  /**
   * @returns 可解析编排及具有对象身份的缺失或损坏事实。
   * @throws {AppException} 无法完成工程范围的编排检查。
   */
  inspectSceneCanvasArrangements(
    project: VerifiedProjectReadLocation
  ): Promise<SceneCanvasArrangementInspectionFact>
}
