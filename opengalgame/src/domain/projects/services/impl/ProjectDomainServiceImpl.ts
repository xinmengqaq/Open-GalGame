import { ProjectErrorCodes } from '../../errors/ProjectErrorCodes'
import { ProjectUnregisteredEvent } from '../../events/ProjectUnregisteredEvent'
import { Project, truncateProjectName } from '../../models/Project'
import type { ProjectRegistrationResult } from '../../models/ProjectRegistrationResult'
import type {
  ProjectCreationRequest,
  ProjectImportRequest,
  ProjectPreparationResult,
  ProjectRecoveryRequest,
  RegisteredProjectIdentity
} from '../../models/ProjectWorkspace'
import type { ProjectDomainService } from '../ProjectDomainService'
import { AppException } from '@common/errors/AppException'

export class ProjectDomainServiceImpl implements ProjectDomainService {
  /** 将登记冲突事实解释为业务错误。 */
  validateRegistration(result: ProjectRegistrationResult): void {
    if (result.status === 'conflict')
      throw new AppException({
        code: ProjectErrorCodes.alreadyRegistered,
        msg: '此项目已登记，不能重复导入'
      })
  }
  /** 按领域规则准备创建，不覆盖既有工作区。 */
  prepareCreation({ project, workspace }: ProjectCreationRequest): ProjectPreparationResult {
    if (workspace.kind === 'existing')
      throw new AppException({
        code: ProjectErrorCodes.destinationOccupied,
        msg: '所选目录已有项目，请使用导入'
      })
    return { project, requiresInitialization: true }
  }
  prepareImport({
    candidate,
    registeredIdentity,
    workspace
  }: ProjectImportRequest): ProjectPreparationResult {
    const project = Project.fromImport(
      workspace.kind === 'existing'
        ? workspace.project
        : {
            ...candidate,
            name: truncateProjectName(workspace.directoryName.trim() || '未命名项目')
          }
    )
    if (registeredIdentity?.id === project.id)
      throw new AppException({
        code: ProjectErrorCodes.alreadyRegistered,
        msg: '此项目已登记，不能重复导入'
      })
    return { project, requiresInitialization: workspace.kind === 'uninitialized' }
  }
  /** 恢复仅允许继续提交同一项目。 */
  validateRecovery({ expectedProject, workspace }: ProjectRecoveryRequest): void {
    if (workspace.kind !== 'existing' || workspace.project.id !== expectedProject.id)
      throw new AppException({
        code: ProjectErrorCodes.packageCorrupted,
        msg: '工程身份已变化，请重新选择目录'
      })
  }

  /** 未登记不能继续打开、重命名或移出。 */
  requireRegistered(
    registeredIdentity: RegisteredProjectIdentity | null
  ): asserts registeredIdentity is RegisteredProjectIdentity {
    if (!registeredIdentity)
      throw new AppException({
        code: ProjectErrorCodes.notRegistered,
        msg: '该项目未在本机列表中'
      })
  }

  /** 未登记不能移出；不检查工程是否可读。 */
  prepareUnregister(
    registeredIdentity: RegisteredProjectIdentity | null
  ): ProjectUnregisteredEvent {
    this.requireRegistered(registeredIdentity)
    return new ProjectUnregisteredEvent({ projectId: registeredIdentity.id })
  }
}
