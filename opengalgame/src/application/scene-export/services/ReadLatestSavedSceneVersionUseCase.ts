import type { ReadLatestSavedSceneVersionDTO } from '../dto/ReadLatestSavedSceneVersionDTO'
import type {
  SavedSceneVersionCandidate,
  SavedSceneVersionQueryGateway
} from '../ports/SavedSceneVersionQueryGateway'
import type { SavedSceneVersionVO } from '../vo/SavedSceneVersionVO'
import { sceneExportVersionKey } from './sceneExportVersion'

/** 只读查询端口，供用户接口层读取当前可导出的正式保存版本。 */
export interface ReadLatestSavedSceneVersionService {
  readLatestSavedSceneVersion(
    request: ReadLatestSavedSceneVersionDTO
  ): Promise<SavedSceneVersionVO | null>
}

/**
 * 在预览保存和生成提交的统一候选里取最新一条。
 * 候选已由网关核对当前正式内容；这里不补造版本，也不放宽来源。
 */
export class ReadLatestSavedSceneVersionUseCase implements ReadLatestSavedSceneVersionService {
  constructor(private readonly gateway: SavedSceneVersionQueryGateway) {}

  async readLatestSavedSceneVersion(
    request: ReadLatestSavedSceneVersionDTO
  ): Promise<SavedSceneVersionVO | null> {
    const candidates = await this.gateway.listExportableSavedSceneVersions(request)
    let latest: SavedSceneVersionCandidate | null = null
    for (const candidate of candidates) {
      if (candidate.projectId !== request.projectId || candidate.sceneId !== request.sceneId) {
        continue
      }
      if (!latest || isNewer(candidate, latest)) latest = candidate
    }
    if (!latest) return null
    return {
      versionReference: latest.versionReference,
      revisionDigest: latest.revisionDigest,
      contentBasis: latest.contentBasis
    }
  }
}

function isNewer(
  candidate: SavedSceneVersionCandidate,
  current: SavedSceneVersionCandidate
): boolean {
  if (candidate.savedAtMs !== current.savedAtMs) return candidate.savedAtMs > current.savedAtMs
  return (
    sceneExportVersionKey(candidate.versionReference) >
    sceneExportVersionKey(current.versionReference)
  )
}
