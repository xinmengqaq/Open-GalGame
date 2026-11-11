import { z } from 'zod'

import type { SceneSourceLocation } from '@application/scenes/models/SceneSourceLocation'
import { AppException } from '@common/errors/AppException'
import { ErrorCodes } from '@common/errors/ErrorCodes'
import type { SceneLockState } from '@domain/scene-generation/models/SceneGenerationRequest'
import { SceneGenerationErrorCodes } from '@domain/scene-generation/errors/SceneGenerationErrorCodes'
import { resolveContained } from '@infrastructure/git/containedPath'
import { readJsonDocument } from '@infrastructure/storage/jsonDocument'

const SCENE_LOCK_PATH = '.opengalgame/scene-locks.json'

const lockDocumentSchema = z
  .object({
    scenes: z.array(
      z.object({ sceneId: z.string().min(1), lockState: z.enum(['locked', 'unlocked']) })
    )
  })
  .refine((document) => {
    const seen: Record<string, true> = {}
    return document.scenes.every((item) => {
      if (seen[item.sceneId]) return false
      seen[item.sceneId] = true
      return true
    })
  })

/**
 * 读取正式工程的场景锁。
 * 文件缺失或没有该场景时保持 unknown，不能默认可编辑。
 */
export async function readSceneLock(source: SceneSourceLocation): Promise<SceneLockState> {
  let value: unknown
  try {
    value = await readJsonDocument(await resolveContained(source.projectRoot, SCENE_LOCK_PATH), {
      code: SceneGenerationErrorCodes.gitQueryFailed,
      msg: '场景锁定事实无法读取'
    })
  } catch (error) {
    if (error instanceof AppException && error.code === ErrorCodes.forbidden) {
      throw new AppException({
        code: SceneGenerationErrorCodes.gitQueryFailed,
        msg: '场景锁定事实无法读取',
        cause: error
      })
    }
    throw error
  }
  if (value === null) return 'unknown'
  const parsed = lockDocumentSchema.safeParse(value)
  if (!parsed.success) {
    throw new AppException({
      code: SceneGenerationErrorCodes.gitQueryFailed,
      msg: '场景锁定文件格式不兼容',
      cause: parsed.error
    })
  }
  return parsed.data.scenes.find((item) => item.sceneId === source.sceneId)?.lockState ?? 'unknown'
}
