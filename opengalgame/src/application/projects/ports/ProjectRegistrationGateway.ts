import type { ProjectOperation } from '../models/ProjectOperation'
import type { ProjectRegistrationResult } from '@domain/projects/models/ProjectRegistrationResult'

export interface ProjectRegistrationGateway {
  /**
   * @param operation - 已发布的项目操作。
   * @returns 原子登记结果，冲突由领域层后续校验拒绝。
   */
  registerProject(operation: ProjectOperation): Promise<ProjectRegistrationResult>

  /**
   * 移除本机登记，不删除工程目录。
   * @returns 已删除或本来就不存在。
   */
  removeRegistration(id: string): Promise<'removed' | 'missing'>
}
