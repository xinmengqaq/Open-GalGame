import { digestVersionParts } from '@infrastructure/project-files/public/projectFileStorage'

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
