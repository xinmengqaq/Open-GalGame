import { z } from 'zod'

import { readWorkspaceDocument, writeWorkspaceDocument } from './projectWorkspaceFiles'
import { parseUnknownValue } from '../validation/parseUnknownValue'
import type {
  ProjectSceneIdentity,
  ProjectSceneIdentityGateway
} from '@application/projects/ports/ProjectSceneIdentityGateway'
import { AppException } from '@common/errors/AppException'
import { ProjectErrorCodes } from '@domain/projects/errors/ProjectErrorCodes'
import { resolveProjectWorkRoot } from '@infrastructure/project-versioning/projectWorkRoot'

export const DEFAULT_SCENE_ID = 'scene-1'
export const DEFAULT_CANVAS_ID = 'canvas-1'
const PROJECT_INFO_PATH = '.opengalgame/project.json'
const IDENTITY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u

const projectInfoSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    synopsis: z.string(),
    sceneId: z.string().optional(),
    canvasId: z.string().optional()
  })
  .catchall(z.unknown())

type ProjectInfoRecord = z.infer<typeof projectInfoSchema>

/**
 * 在工程信息中补齐默认场景和画布身份。
 * 已有合法身份原样保留，不改名称、简介或未知字段。
 */
export class LocalProjectSceneIdentityGatewayImpl implements ProjectSceneIdentityGateway {
  constructor(private readonly userDirectory: string) {}

  async ensureIdentity(projectId: string): Promise<ProjectSceneIdentity> {
    const root = await resolveProjectWorkRoot(this.userDirectory, projectId)
    const document = await loadProjectInfo(root, projectId)
    const sceneId = normalizeIdentity(document.sceneId, DEFAULT_SCENE_ID)
    const canvasId = normalizeIdentity(document.canvasId, DEFAULT_CANVAS_ID)
    if (document.sceneId !== sceneId || document.canvasId !== canvasId) {
      await writeWorkspaceDocument(root, PROJECT_INFO_PATH, { ...document, sceneId, canvasId })
    }
    return { sceneId, canvasId }
  }

  async readIdentity(projectId: string): Promise<ProjectSceneIdentity | null> {
    const root = await resolveProjectWorkRoot(this.userDirectory, projectId)
    const document = await loadProjectInfo(root, projectId)
    if (document.sceneId === undefined && document.canvasId === undefined) return null
    if (document.sceneId === undefined || document.canvasId === undefined) {
      if (document.sceneId !== undefined) normalizeIdentity(document.sceneId, DEFAULT_SCENE_ID)
      if (document.canvasId !== undefined) normalizeIdentity(document.canvasId, DEFAULT_CANVAS_ID)
      return null
    }
    return {
      sceneId: normalizeIdentity(document.sceneId, DEFAULT_SCENE_ID),
      canvasId: normalizeIdentity(document.canvasId, DEFAULT_CANVAS_ID)
    }
  }
}

async function loadProjectInfo(root: string, projectId: string): Promise<ProjectInfoRecord> {
  const value = await readWorkspaceDocument(root, PROJECT_INFO_PATH)
  if (value === null) {
    throw new AppException({
      code: ProjectErrorCodes.missingRequiredContent,
      msg: '已有工程缺少工程信息文件'
    })
  }
  const document: ProjectInfoRecord = parseUnknownValue(
    projectInfoSchema,
    value,
    ProjectErrorCodes.packageCorrupted,
    '工程信息文件损坏'
  )
  if (document.id !== projectId) {
    throw new AppException({
      code: ProjectErrorCodes.packageCorrupted,
      msg: '工程信息与登记身份不一致'
    })
  }
  return document
}

function normalizeIdentity(value: string | undefined, fallback: string): string {
  if (value === undefined) return fallback
  if (!IDENTITY_PATTERN.test(value)) {
    throw new AppException({ code: ProjectErrorCodes.packageCorrupted, msg: '工程场景身份损坏' })
  }
  return value
}
