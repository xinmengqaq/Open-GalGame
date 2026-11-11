import type { ReadLatestPreviewSaveDTO } from '../dto/ReadLatestPreviewSaveDTO'
import type {
  PreviewSaveVersionCandidate,
  PreviewSaveVersionQueryGateway
} from '../ports/PreviewSaveVersionQueryGateway'
import type { PreviewSaveVersionVO } from '../vo/PreviewSaveVersionVO'

/** 只读查询端口，供用户接口层在不改导出契约的前提下读取最近保存版本。 */
export interface ReadLatestPreviewSaveService {
  readLatestPreviewSave(request: ReadLatestPreviewSaveDTO): Promise<PreviewSaveVersionVO | null>
}

/**
 * 读取该工程该场景最近一次已结算的预览保存版本。
 * 按保存记录时间取最新；没有合格记录时返回 null。
 */
export class ReadLatestPreviewSaveUseCase implements ReadLatestPreviewSaveService {
  constructor(private readonly gateway: PreviewSaveVersionQueryGateway) {}

  async readLatestPreviewSave(
    request: ReadLatestPreviewSaveDTO
  ): Promise<PreviewSaveVersionVO | null> {
    const candidates = await this.gateway.listSettledPreviewSaves(request)
    let latest: PreviewSaveVersionCandidate | null = null
    for (const candidate of candidates) {
      if (candidate.projectId !== request.projectId || candidate.sceneId !== request.sceneId) {
        continue
      }
      if (!latest || candidate.savedAtMs > latest.savedAtMs) {
        latest = candidate
      } else if (candidate.savedAtMs === latest.savedAtMs && candidate.requestId > latest.requestId) {
        latest = candidate
      }
    }
    if (!latest) return null
    return {
      requestId: latest.requestId,
      revisionDigest: latest.revisionDigest,
      contentBasis: latest.contentBasis
    }
  }
}
