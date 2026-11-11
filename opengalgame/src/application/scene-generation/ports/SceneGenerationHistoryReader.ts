import type {
  ListSceneGenerationHistoryDTO,
  ReadSceneGenerationCheckpointDTO
} from '../dto/SceneGenerationDTO'
import type { SceneGenerationCheckpoint } from '../models/SceneGenerationExecution'
import type { SceneGenerationHistoryVO } from '../vo/SceneGenerationVO'

export interface SceneGenerationHistoryReader {
  /**
   * 分页读取安全分支与检查点摘要，不执行模型、工具或文件修复。
   * @returns 安全历史分页，不含原始检查点、系统提示或内部任务配置。
   * @throws {AppException} 身份越界或历史读取失败。
   */
  listHistory(request: ListSceneGenerationHistoryDTO): Promise<SceneGenerationHistoryVO>

  /**
   * 只读取得安全历史详情与应用恢复种子；可继续标记须核对完整输入、基线和快照兼容性。
   * @returns 安全展示与内部种子分开保存的历史事实，准备阶段明确允许空候选。
   * @throws {AppException} 身份越界或历史不存在。
   */
  readCheckpoint(request: ReadSceneGenerationCheckpointDTO): Promise<SceneGenerationCheckpoint>
}
