import type { ProjectUnregisteredEvent } from '../events/ProjectUnregisteredEvent'
import type { ProjectRegistrationResult } from '../models/ProjectRegistrationResult'
import type {
  ProjectCreationRequest,
  ProjectImportRequest,
  ProjectPreparationResult,
  ProjectRecoveryRequest,
  RegisteredProjectIdentity
} from '../models/ProjectWorkspace'

export interface ProjectDomainService {
  /** 校验登记结果中的业务冲突。 @param result - 原子登记事实。 @throws {AppException} 项目已被登记。 */
  validateRegistration(result: ProjectRegistrationResult): void
  /**
   * @throws {AppException} 工作区已有项目。
   */
  prepareCreation(request: ProjectCreationRequest): ProjectPreparationResult
  /**
   * @throws {AppException} 项目信息非法或身份重复。
   */
  prepareImport(request: ProjectImportRequest): ProjectPreparationResult
  /**
   * 校验恢复期间目录仍属于原项目。
   * @throws {AppException} 身份消失或变化。
   */
  validateRecovery(request: ProjectRecoveryRequest): void
  /**
   * @param registeredIdentity - 查询到的登记身份，未登记时为 null。
   * @throws {AppException} 项目未在本机列表中。
   */
  requireRegistered(
    registeredIdentity: RegisteredProjectIdentity | null
  ): asserts registeredIdentity is RegisteredProjectIdentity
  /**
   * 确认登记仍存在后允许移出列表。
   * @param registeredIdentity - 查询到的登记身份，未登记时为 null。
   * @throws {AppException} 项目未在本机列表中。
   */
  prepareUnregister(registeredIdentity: RegisteredProjectIdentity | null): ProjectUnregisteredEvent
}
