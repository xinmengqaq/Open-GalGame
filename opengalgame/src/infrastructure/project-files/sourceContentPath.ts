import type { ProjectInputSourceDocument } from './documents/ProjectInputSourceDocument'
import { assertAssetMediaPath, documentBodyPath } from './projectFilePaths'

export function contentRelativePath(document: ProjectInputSourceDocument): string {
  if (document.content.kind === 'document') {
    return documentBodyPath(
      document.sourceId,
      document.content.importFormat === 'markdown' ? 'md' : 'txt'
    )
  }
  return assertAssetMediaPath(document.content.mediaPath)
}
