import type { StartSceneGenerationDTO } from '../../dto/SceneGenerationDTO'
import { AppException } from '@common/errors/AppException'
import { ProjectErrorCodes } from '@domain/projects/errors/ProjectErrorCodes'
import { SceneCanvasErrorCodes } from '@domain/scene-canvas/errors/SceneCanvasErrorCodes'
import type { SceneGenerationDependencies } from './SceneGenerationCoordinator'
import type { SceneGenerationRenderDependencies } from './SceneGenerationRenderDependencies'

export async function saveLaunchArrangement(
  deps: SceneGenerationDependencies,
  renderDeps: SceneGenerationRenderDependencies,
  snapshot: StartSceneGenerationDTO
): Promise<{ arrangementVersion: string }> {
  let workspace
  try {
    workspace = await deps.versions.ensureWorkspace(snapshot.projectId)
  } catch (error) {
    if (error instanceof AppException && error.code === ProjectErrorCodes.workspaceNotReady) {
      throw new AppException({
        code: ProjectErrorCodes.workspaceNotReady,
        msg: '工程初始化未完成，请重新构建',
        cause: error
      })
    }
    throw error
  }
  if (workspace.sceneId !== snapshot.sceneId || workspace.canvasId !== snapshot.canvasId) {
    throw new AppException({
      code: SceneCanvasErrorCodes.identityMismatch,
      msg: '当前场景画布身份不一致'
    })
  }
  const arrangement = await renderDeps.readCurrentArrangement(snapshot)
  if (!arrangement) {
    throw new AppException({
      code: SceneCanvasErrorCodes.targetMissing,
      msg: '当前场景画布没有可保存的编排'
    })
  }
  if (
    arrangement.projectId !== snapshot.projectId ||
    arrangement.sceneId !== snapshot.sceneId ||
    arrangement.canvasId !== snapshot.canvasId
  ) {
    throw new AppException({
      code: SceneCanvasErrorCodes.identityMismatch,
      msg: '当前场景画布身份不一致'
    })
  }
  try {
    await renderDeps.saveArrangement({
      projectId: snapshot.projectId,
      sceneId: snapshot.sceneId,
      canvasId: snapshot.canvasId,
      reason: 'beforeGeneration',
      arrangement
    })
  } catch (error) {
    if (error instanceof AppException) throw error
    throw new AppException({
      code: SceneCanvasErrorCodes.commitUnknown,
      msg: '编排提交结果尚未查明',
      cause: error
    })
  }
  const saved = await renderDeps.canvasVersions.readArrangementVersion(snapshot)
  if (
    saved.projectId !== snapshot.projectId ||
    saved.sceneId !== snapshot.sceneId ||
    saved.canvasId !== snapshot.canvasId ||
    saved.arrangementVersion.trim() === ''
  ) {
    throw new AppException({
      code: SceneCanvasErrorCodes.commitUnknown,
      msg: '编排提交结果尚未查明'
    })
  }
  return saved
}
