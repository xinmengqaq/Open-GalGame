import { encodeStorageKey } from '@infrastructure/project-files/public/projectFileStorage'

export const CANVAS_DIRECTORY = '.opengalgame/canvases'

export function arrangementPath(sceneId: string, canvasId: string): string {
  return `${CANVAS_DIRECTORY}/${encodeStorageKey(sceneId)}/${encodeStorageKey(canvasId)}.json`
}
