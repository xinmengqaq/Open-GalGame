import type { SceneExportVersionReference } from '../vo/SceneExportVO'

/** 稳定身份键：只用于同一次导出的去重、缓存和产物目录命名。 */
export function sceneExportVersionKey(reference: SceneExportVersionReference): string {
  return reference.kind === 'preview-save'
    ? `preview-save\u0000${reference.requestId}`
    : `generation-commit\u0000${reference.operationId}\u0000${reference.commitId}`
}

export function sameSceneExportVersion(
  left: SceneExportVersionReference,
  right: SceneExportVersionReference
): boolean {
  return sceneExportVersionKey(left) === sceneExportVersionKey(right)
}
