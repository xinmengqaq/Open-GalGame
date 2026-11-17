import { digestVersionParts } from '@infrastructure/project-files/public/projectFileStorage'

/** 当前编排读取版本。旧 v3/v4 映射已归迁移工具，仅保留当前事实派生。 */
export function toArrangementVersion(
  projectId: string,
  sceneId: string,
  canvasId: string,
  fileDigest: string
): string {
  return digestVersionParts([
    'project-file-arrangement-v1',
    projectId,
    sceneId,
    canvasId,
    fileDigest
  ])
}
