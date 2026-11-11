import type { CandidatePreviewSessionLookup } from '@application/scenes/ports/CandidatePreviewSessionLookup'
import type {
  CandidatePreviewSessionGateway,
  ResolveCandidatePreviewSessionRequest
} from '@application/scenes/ports/CandidatePreviewSessionGateway'
import type { CandidatePreviewSessionResolution } from '@application/scenes/models/CandidatePreviewSession'
import { AppException } from '@common/errors/AppException'
import { ErrorCodes } from '@common/errors/ErrorCodes'

/**
 * 只核对生成侧已保存的固定候选会话。
 * 预期拒绝不读取文件，也不回退正式工程。
 */
export class CandidatePreviewSessionGatewayImpl implements CandidatePreviewSessionGateway {
  constructor(
    private readonly lookup: CandidatePreviewSessionLookup,
    private readonly now: () => number = Date.now
  ) {}

  async resolveCandidatePreviewSession(
    request: ResolveCandidatePreviewSessionRequest
  ): Promise<CandidatePreviewSessionResolution> {
    let record
    try {
      record = this.lookup.findCandidatePreviewSession(request.previewSessionId)
    } catch (error) {
      throw new AppException({
        code: ErrorCodes.internalError,
        msg: '候选预览会话暂时无法读取',
        cause: error
      })
    }
    if (!record) return { status: 'rejected', reason: 'missing' }
    if (record.projectId !== request.projectId || record.sceneId !== request.sceneId) {
      return { status: 'rejected', reason: 'mismatch' }
    }
    if (record.state === 'expired' || Date.parse(record.expiresAt) <= this.now()) {
      return { status: 'rejected', reason: 'expired' }
    }
    if (
      record.projectRoot.trim() === '' ||
      record.entryFile.trim() === '' ||
      record.candidateSnapshotId.trim() === ''
    ) {
      throw new AppException({ code: ErrorCodes.internalError, msg: '候选预览会话暂时无法读取' })
    }
    return {
      status: 'resolved',
      session: {
        previewSessionId: record.previewSessionId,
        projectId: record.projectId,
        sceneId: record.sceneId,
        sceneName: record.sceneName,
        candidateSnapshotId: record.candidateSnapshotId,
        projectRoot: record.projectRoot,
        entryFile: record.entryFile,
        metadataFiles: record.metadataFiles,
        expiresAt: record.expiresAt
      }
    }
  }
}
