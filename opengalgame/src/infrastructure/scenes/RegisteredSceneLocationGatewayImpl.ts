import { readdir } from 'node:fs/promises'
import { isAbsolute } from 'node:path'

import type { SceneSourceLocation } from '@application/scenes/models/SceneSourceLocation'
import type { ProjectListQueryGateway } from '@application/projects/ports/ProjectListQueryGateway'
import { AppException } from '@common/errors/AppException'
import { ErrorCodes } from '@common/errors/ErrorCodes'
import { Project } from '@domain/projects/models/Project'
import { resolveContained } from '@infrastructure/git/containedPath'
import {
  encodeStorageKey,
  projectFileLocations
} from '@infrastructure/project-files/projectFilePaths'
import { LocalProjectListQueryGatewayImpl } from '@infrastructure/projects/LocalProjectListQueryGatewayImpl'
import { LocalProjectStorageGatewayImpl } from '@infrastructure/projects/LocalProjectStorageGatewayImpl'
import { WEBGAL_COMPATIBILITY_PROFILE } from '@infrastructure/webgal/compatibility/WebgalCompatibilityProfile'

/**
 * 从本机已登记工程和已保存场景画布定位正式场景。
 * 不读取静态测试登记，也不把唯一脚本猜测成已登记场景。
 */
export class RegisteredSceneLocationGatewayImpl {
  constructor(private readonly userDirectory: string) {}

  async resolveRegisteredScene(scene: {
    projectId: string
    sceneId: string
  }): Promise<SceneSourceLocation> {
    if (scene.projectId.trim() === '' || scene.sceneId.trim() === '') {
      throw new AppException({ code: ErrorCodes.invalidRequest, msg: '当前工程场景未登记' })
    }
    const projects: ProjectListQueryGateway = new LocalProjectListQueryGatewayImpl(
      this.userDirectory
    )
    const registration = await projects.findRegistration(scene.projectId)
    if (!registration) {
      throw new AppException({ code: ErrorCodes.invalidRequest, msg: '当前工程场景未登记' })
    }
    const inspection = await new LocalProjectStorageGatewayImpl().inspect({
      directory: registration.directory
    })
    const project = Project.restoreRegisteredProject({
      workspace: inspection,
      identity: { id: registration.id }
    })
    if (project.id !== scene.projectId || !isAbsolute(registration.directory)) {
      throw new AppException({ code: ErrorCodes.forbidden, msg: '当前工程场景未登记' })
    }
    const canvasDirectory = await resolveContained(
      registration.directory,
      `${projectFileLocations.canvases}/${encodeStorageKey(scene.sceneId)}`
    )
    let names: string[]
    try {
      names = await readdir(canvasDirectory)
    } catch (error) {
      throw new AppException({
        code: ErrorCodes.invalidRequest,
        msg: '当前工程场景未登记',
        cause: error
      })
    }
    if (!names.some((name) => name.endsWith('.json'))) {
      throw new AppException({ code: ErrorCodes.invalidRequest, msg: '当前工程场景未登记' })
    }
    const entry = WEBGAL_COMPATIBILITY_PROFILE.entryScript
    await resolveContained(registration.directory, entry)
    const separator = entry.lastIndexOf('/')
    return {
      projectId: scene.projectId,
      sceneId: scene.sceneId,
      projectRoot: registration.directory,
      sceneDirectory: entry.slice(0, separator),
      entryFile: entry.slice(separator + 1)
    }
  }
}
