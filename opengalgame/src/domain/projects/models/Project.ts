import { ProjectErrorCodes } from '../errors/ProjectErrorCodes'
import { ProjectCreatedEvent } from '../events/ProjectCreatedEvent'
import { ProjectImportedEvent } from '../events/ProjectImportedEvent'
import { ProjectRenamedEvent } from '../events/ProjectRenamedEvent'
import type { ProjectUnregisteredEvent } from '../events/ProjectUnregisteredEvent'
import type {
  ProjectInfo,
  RegisteredProjectIdentity,
  WorkspaceInspection
} from './ProjectWorkspace'
import { AppException } from '@common/errors/AppException'

export const PROJECT_NAME_MAX_LENGTH = 40
export const PROJECT_ID_MAX_LENGTH = 64

export type ProjectDomainEvent =
  ProjectCreatedEvent | ProjectImportedEvent | ProjectRenamedEvent | ProjectUnregisteredEvent

const projectNameGraphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' })

/**
 * 把项目名称切分为字素序列。按字素计数可让组合字符与表情各占一个名额。
 * @returns 逐字素的名称片段。
 */
function splitProjectNameGraphemes(name: string): string[] {
  return Array.from(projectNameGraphemes.segment(name), (item) => item.segment)
}

/**
 * 判断项目名称是否超出长度上限。按字素计数，组合字符与表情算一个名额。
 * @param name - 已去空白的名称。
 */
export function isProjectNameTooLong(name: string): boolean {
  return splitProjectNameGraphemes(name).length > PROJECT_NAME_MAX_LENGTH
}

/**
 * 按字素把项目名称截断到长度上限。
 * @returns 不超过上限的名称，未超限时原样返回。
 */
export function truncateProjectName(name: string): string {
  const graphemes = splitProjectNameGraphemes(name)
  return graphemes.length > PROJECT_NAME_MAX_LENGTH
    ? graphemes.slice(0, PROJECT_NAME_MAX_LENGTH).join('')
    : name
}

/**
 * 校验并规范化项目身份，统一去空白并补齐简介。
 * @throws {AppException} 标识无效、名称为空或超出长度限制。
 */
function normalizeProjectInfo({ id, name, synopsis }: ProjectInfo): Required<ProjectInfo> {
  if (id.length === 0 || /\s/.test(id) || [...id].length > PROJECT_ID_MAX_LENGTH) {
    throw new AppException({ code: ProjectErrorCodes.invalidId, msg: '项目标识缺失或无效' })
  }

  const trimmedName = name.trim()
  if (trimmedName.length === 0) {
    throw new AppException({ code: ProjectErrorCodes.emptyName, msg: '项目名称不能为空' })
  }
  if (isProjectNameTooLong(trimmedName)) {
    throw new AppException({ code: ProjectErrorCodes.nameTooLong, msg: '项目名称超出长度限制' })
  }

  return { id, name: trimmedName, synopsis: synopsis ?? '' }
}

export class Project {
  /** 建立已规范化的项目实例，仅供本类内部方法调用。 */
  private constructor(
    readonly id: string,
    readonly name: string,
    readonly synopsis: string,
    readonly events: readonly ProjectDomainEvent[]
  ) {}

  /**
   * 建立合法的新建项目。尚未保存。
   * @param input - 项目身份模型，包含调用方分配的标识、名称与可选简介。
   * @throws {AppException} 名称或标识不合法。
   */
  static create(input: ProjectInfo): Project {
    const info = normalizeProjectInfo(input)
    return new Project(info.id, info.name, info.synopsis, [
      new ProjectCreatedEvent({ projectId: info.id, name: info.name })
    ])
  }

  /**
   * 从导入事实建立项目。尚未保存。
   * @throws {AppException} 名称或标识不合法。
   */
  static fromImport(input: ProjectInfo): Project {
    const info = normalizeProjectInfo(input)
    return new Project(info.id, info.name, info.synopsis, [
      new ProjectImportedEvent({ projectId: info.id, name: info.name })
    ])
  }

  /**
   * 恢复持久化身份，不重新产生事件。
   * @returns 无待发布事件的项目。
   * @throws {AppException} 身份不符合领域规则。
   */
  static restore(input: ProjectInfo): Project {
    const info = normalizeProjectInfo(input)
    return new Project(info.id, info.name, info.synopsis, [])
  }

  /**
   * @throws {AppException} 内容缺失或登记身份不一致。
   */
  static restoreRegisteredProject(input: {
    workspace: WorkspaceInspection
    identity: RegisteredProjectIdentity
  }): Project {
    if (input.workspace.kind !== 'existing')
      throw new AppException({
        code: ProjectErrorCodes.missingRequiredContent,
        msg: '登记的项目内容缺失，无法读取'
      })
    const project = Project.restore(input.workspace.project)
    project.validateRegisteredIdentity(input.identity)
    return project
  }

  /**
   * @throws {AppException} 登记标识与本工程标识不一致。
   */
  validateRegisteredIdentity(identity: RegisteredProjectIdentity): void {
    if (identity.id !== this.id)
      throw new AppException({
        code: ProjectErrorCodes.packageCorrupted,
        msg: '工程身份与登记不一致'
      })
  }

  /**
   * @throws {AppException} 名称不合法。
   */
  rename(input: { name: string; synopsis?: string }): Project {
    const info = normalizeProjectInfo({
      id: this.id,
      name: input.name,
      synopsis: input.synopsis
    })
    return new Project(info.id, info.name, info.synopsis, [
      ...this.events,
      new ProjectRenamedEvent({ projectId: info.id, name: info.name })
    ])
  }
}
