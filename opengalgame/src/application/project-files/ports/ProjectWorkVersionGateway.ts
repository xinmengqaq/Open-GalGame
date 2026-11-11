import type { ProjectFileOperationSettlement } from '../vo/ProjectFileOperationVO'

export type { ProjectFileOperationSettlement }
import type { PreparedProjectFileChange } from './ProjectFileOperationGateway'
import type { VerifiedProjectReadLocation } from '../models/ProjectInputSourceReadFacts'

/** 发布一次文件操作拥有的路径变更，并在失败时只补偿这些路径。 */
export interface ProjectWorkVersionGateway {
  /**
   * 在作品版本边界内发布变更。
   * 提交前按准备目录时的版本再读目录，不一致则拒绝。
   * @throws {AppException} 提交失败或目录版本已变化。结果不明确时使用提交不明错误，并保留补偿失败。
   */
  publish(request: {
    project: VerifiedProjectReadLocation
    operationId: string
    changes: readonly PreparedProjectFileChange[]
    watchedPaths?: readonly string[]
    expectedCatalogVersion: string
  }): Promise<void>

  /**
   * 按操作标识核对这次提交是否已经落地。不写入。
   * @returns 已提交、未提交，或仍不能判定。
   * @throws {AppException} 仓库无法读取。
   */
  readOperation(
    project: VerifiedProjectReadLocation,
    operationId: string
  ): Promise<ProjectFileOperationSettlement>
}
