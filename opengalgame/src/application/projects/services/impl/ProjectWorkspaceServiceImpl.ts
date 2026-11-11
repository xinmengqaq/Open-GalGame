import type { EnsureProjectWorkspaceDTO } from '../../dto/ProjectWorkspaceDTO'
import type { ProjectBaselineGateway } from '../../ports/ProjectBaselineGateway'
import type { ProjectSceneIdentityGateway } from '../../ports/ProjectSceneIdentityGateway'
import type { ProjectSceneSeedGateway } from '../../ports/ProjectSceneSeedGateway'
import type { ProjectWorkspaceInspectionVO, ProjectWorkspaceVO } from '../../vo/ProjectWorkspaceVO'
import type { ProjectWorkspaceService } from '../ProjectWorkspaceService'
import { AppException } from '@common/errors/AppException'
import { ErrorCodes } from '@common/errors/ErrorCodes'
import { ProjectErrorCodes } from '@domain/projects/errors/ProjectErrorCodes'

const PROJECT_INFO_PATH = '.opengalgame/project.json'
const MANIFEST_PATH = '.opengalgame/manifest.json'
const SCENE_SCRIPT_PATH = 'game/scene/start.txt'
const SCENE_LOCK_PATH = '.opengalgame/scene-locks.json'

interface ProjectWorkspaceDependencies {
  readonly identity: ProjectSceneIdentityGateway
  readonly seeds: ProjectSceneSeedGateway
  readonly baseline: ProjectBaselineGateway
}

/**
 * 编排默认身份、缺失场景文件和声明路径基线。
 * 技术失败统一变成可重试的初始化失败，不暴露内部原因。
 */
export class ProjectWorkspaceServiceImpl implements ProjectWorkspaceService {
  constructor(private readonly deps: ProjectWorkspaceDependencies) {}

  async ensureProjectWorkspace(request: EnsureProjectWorkspaceDTO): Promise<ProjectWorkspaceVO> {
    requireProjectId(request.projectId)
    try {
      const identity = await this.deps.identity.ensureIdentity(request.projectId)
      await this.deps.seeds.ensureSceneFiles(request.projectId, identity.sceneId)
      await this.deps.baseline.ensureDeclaredPaths(request.projectId, DECLARED_PATHS)
      return {
        projectId: request.projectId,
        sceneId: identity.sceneId,
        canvasId: identity.canvasId
      }
    } catch (error) {
      throw workspaceFailure(error)
    }
  }

  async inspectProjectWorkspace(
    request: EnsureProjectWorkspaceDTO
  ): Promise<ProjectWorkspaceInspectionVO> {
    requireProjectId(request.projectId)
    let identity: { sceneId: string; canvasId: string } | null
    try {
      identity = await this.deps.identity.readIdentity(request.projectId)
    } catch (error) {
      throw workspaceFailure(error)
    }
    if (identity === null) return { ready: false }
    try {
      const filesReady = await this.deps.seeds.inspectSceneFiles(
        request.projectId,
        identity.sceneId
      )
      const baselineReady = await this.deps.baseline.inspectDeclaredPaths(
        request.projectId,
        DECLARED_PATHS
      )
      return {
        ready: filesReady && baselineReady,
        sceneId: identity.sceneId,
        canvasId: identity.canvasId
      }
    } catch (error) {
      throw workspaceFailure(error)
    }
  }
}

const DECLARED_PATHS = [PROJECT_INFO_PATH, MANIFEST_PATH, SCENE_SCRIPT_PATH, SCENE_LOCK_PATH]

function requireProjectId(projectId: string): void {
  if (typeof projectId !== 'string' || projectId.trim() === '' || projectId !== projectId.trim()) {
    throw new AppException({ code: ErrorCodes.invalidRequest, msg: '工程身份不正确' })
  }
}

function workspaceFailure(error: unknown): AppException {
  if (error instanceof AppException && error.code === ErrorCodes.invalidRequest) {
    return error
  }
  if (error instanceof AppException && error.code === ProjectErrorCodes.workspaceNotReady) {
    return error
  }
  return new AppException({
    code: ProjectErrorCodes.workspaceNotReady,
    msg: '工程初始化未完成，请重新构建',
    cause: error
  })
}
