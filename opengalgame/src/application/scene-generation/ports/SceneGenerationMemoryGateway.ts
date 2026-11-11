import type { SceneGenerationThreadDTO } from '../dto/SceneGenerationDTO'

export interface SceneGenerationMemoryGateway {
  /**
   * 清理已结束线程的记忆、检查点及关联内容，按引用保留其他分支仍使用的文件。
   * @param scope - 已由应用确认没有活动操作的线程。
   * @throws {AppException} 清理失败；不得修改正式作品或其他线程。
   */
  clearMemory(scope: SceneGenerationThreadDTO): Promise<void>
}
