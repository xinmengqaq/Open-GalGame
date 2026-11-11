import { z } from 'zod'

import {
  ensureEmptyFile,
  ensureRealDirectory,
  isRealWorkspaceFile,
  readWorkspaceDocument,
  writeWorkspaceDocument
} from './projectWorkspaceFiles'
import { parseUnknownValue } from '../validation/parseUnknownValue'
import type { ProjectSceneSeedGateway } from '@application/projects/ports/ProjectSceneSeedGateway'
import { AppException } from '@common/errors/AppException'
import { ProjectErrorCodes } from '@domain/projects/errors/ProjectErrorCodes'
import { resolveProjectWorkRoot } from '@infrastructure/project-versioning/projectWorkRoot'

const SCENE_DIRECTORY = 'game/scene'
const SCENE_SCRIPT_PATH = 'game/scene/start.txt'
const SCENE_LOCK_PATH = '.opengalgame/scene-locks.json'

const lockEntrySchema = z
  .object({
    sceneId: z.string().min(1),
    lockState: z.enum(['locked', 'unlocked'])
  })
  .catchall(z.unknown())
const lockDocumentSchema = z
  .object({
    scenes: z.array(lockEntrySchema)
  })
  .catchall(z.unknown())
  .refine(
    (document) =>
      new Set(document.scenes.map((item) => item.sceneId)).size === document.scenes.length
  )

/**
 * 只补缺失的默认场景脚本和对应锁项。
 * 已有脚本不改写；已有锁状态、其他场景和未知字段都保留。
 */
export class LocalProjectSceneSeedGatewayImpl implements ProjectSceneSeedGateway {
  constructor(private readonly userDirectory: string) {}

  async ensureSceneFiles(projectId: string, sceneId: string): Promise<void> {
    if (sceneId.trim() === '') {
      throw new AppException({ code: ProjectErrorCodes.packageCorrupted, msg: '工程场景身份损坏' })
    }
    const root = await resolveProjectWorkRoot(this.userDirectory, projectId)
    await ensureRealDirectory(root, SCENE_DIRECTORY)
    await ensureEmptyFile(root, SCENE_SCRIPT_PATH)
    await ensureSceneLock(root, sceneId)
  }

  async inspectSceneFiles(projectId: string, sceneId: string): Promise<boolean> {
    if (sceneId.trim() === '') return false
    const root = await resolveProjectWorkRoot(this.userDirectory, projectId)
    if (!(await isRealWorkspaceFile(root, SCENE_SCRIPT_PATH))) return false
    try {
      const value = await readWorkspaceDocument(root, SCENE_LOCK_PATH)
      if (value === null) return false
      const document = parseUnknownValue(
        lockDocumentSchema,
        value,
        ProjectErrorCodes.packageCorrupted,
        '场景锁定文件损坏'
      )
      return document.scenes.some((item) => item.sceneId === sceneId)
    } catch (error) {
      if (error instanceof AppException && error.code === ProjectErrorCodes.packageCorrupted) {
        return false
      }
      throw error
    }
  }
}

async function ensureSceneLock(root: string, sceneId: string): Promise<void> {
  const value = await readWorkspaceDocument(root, SCENE_LOCK_PATH)
  if (value === null) {
    await writeWorkspaceDocument(root, SCENE_LOCK_PATH, {
      scenes: [{ sceneId, lockState: 'unlocked' }]
    })
    return
  }
  const document = parseUnknownValue(
    lockDocumentSchema,
    value,
    ProjectErrorCodes.packageCorrupted,
    '场景锁定文件损坏'
  )
  if (document.scenes.some((item) => item.sceneId === sceneId)) return
  await writeWorkspaceDocument(root, SCENE_LOCK_PATH, {
    ...document,
    scenes: [...document.scenes, { sceneId, lockState: 'unlocked' }]
  })
}
