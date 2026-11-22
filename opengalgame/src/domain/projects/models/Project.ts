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

function splitProjectNameGraphemes(name: string): string[] {
  return Array.from(projectNameGraphemes.segment(name), (item) => item.segment)
}

export function isProjectNameTooLong(name: string): boolean {
  return splitProjectNameGraphemes(name).length > PROJECT_NAME_MAX_LENGTH
}

export function truncateProjectName(name: string): string {
  const graphemes = splitProjectNameGraphemes(name)
  return graphemes.length > PROJECT_NAME_MAX_LENGTH
    ? graphemes.slice(0, PROJECT_NAME_MAX_LENGTH).join('')
    : name
}

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
  private constructor(
    readonly id: string,
    readonly name: string,
    readonly synopsis: string,
    readonly events: readonly ProjectDomainEvent[]
  ) {}

  static create(input: ProjectInfo): Project {
    const info = normalizeProjectInfo(input)
    return new Project(info.id, info.name, info.synopsis, [
      new ProjectCreatedEvent({ projectId: info.id, name: info.name })
    ])
  }

  static fromImport(input: ProjectInfo): Project {
    const info = normalizeProjectInfo(input)
    return new Project(info.id, info.name, info.synopsis, [
      new ProjectImportedEvent({ projectId: info.id, name: info.name })
    ])
  }

  static restore(input: ProjectInfo): Project {
    const info = normalizeProjectInfo(input)
    return new Project(info.id, info.name, info.synopsis, [])
  }

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

  validateRegisteredIdentity(identity: RegisteredProjectIdentity): void {
    if (identity.id !== this.id)
      throw new AppException({
        code: ProjectErrorCodes.packageCorrupted,
        msg: '工程身份与登记不一致'
      })
  }

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
