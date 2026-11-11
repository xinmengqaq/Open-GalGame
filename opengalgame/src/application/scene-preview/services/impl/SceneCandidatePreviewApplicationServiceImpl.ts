import type { SceneAssetReferenceGateway } from '../../../scenes/ports/SceneAssetReferenceGateway'
import type { CandidatePreviewSessionGateway } from '../../../scenes/ports/CandidatePreviewSessionGateway'
import type { SceneScriptParserGateway } from '../../../scenes/ports/SceneScriptParserGateway'
import type { SceneSourceReaderGateway } from '../../../scenes/ports/SceneSourceReaderGateway'
import type { ReadCandidatePreviewDTO } from '../../dto/ReadCandidatePreviewDTO'
import { toCandidatePreviewIssues, toCandidatePreviewVO } from '../../mapping/toCandidatePreviewVO'
import type { CandidatePreviewReadContext } from '../../models/CandidatePreviewReadContext'
import type { SceneCompatibilityGateway } from '../../ports/SceneCompatibilityGateway'
import type { CandidatePreviewVO } from '../../vo/CandidatePreviewVO'
import type { SceneCandidatePreviewApplicationService } from '../SceneCandidatePreviewApplicationService'
import {
  candidateCompatibilityFailure,
  candidateSessionRejection,
  candidateSourceFailure,
  isCandidateSourceUnavailable
} from './candidatePreviewErrors'
import type { CandidatePreviewSession } from '../../../scenes/models/CandidatePreviewSession'

export interface SceneCandidatePreviewApplicationDependencies {
  readonly sessions: CandidatePreviewSessionGateway
  readonly sources: SceneSourceReaderGateway
  readonly parser: SceneScriptParserGateway
  readonly references: SceneAssetReferenceGateway
  readonly compatibility: SceneCompatibilityGateway
}

/** 只读编排固定候选。不缓存，不回退正式工程，不扩展播放定位。 */
export class SceneCandidatePreviewApplicationServiceImpl implements SceneCandidatePreviewApplicationService {
  constructor(private readonly deps: SceneCandidatePreviewApplicationDependencies) {}

  async readCandidatePreview(request: ReadCandidatePreviewDTO): Promise<CandidatePreviewVO> {
    const first = await this.resolve(request)
    const context = await this.readResolved(first, request, true)
    const final = await this.resolve(request)
    if (!sameCandidate(first, final))
      throw candidateSessionRejection({ status: 'rejected', reason: 'mismatch' })
    return toCandidatePreviewVO({ ...context, session: final })
  }

  private async readResolved(
    session: CandidatePreviewSession,
    request: ReadCandidatePreviewDTO,
    allowRetry: boolean
  ): Promise<CandidatePreviewReadContext> {
    try {
      return await this.readOnce(session)
    } catch (error) {
      if (!allowRetry || !isCandidateSourceUnavailable(error)) throw candidateSourceFailure(error)
      const resolved = await this.resolve(request)
      if (!sameCandidate(session, resolved)) {
        throw candidateSessionRejection({ status: 'rejected', reason: 'mismatch' })
      }
      try {
        return await this.readOnce(resolved)
      } catch (retryError) {
        throw candidateSourceFailure(retryError)
      }
    }
  }

  private async readOnce(session: CandidatePreviewSession): Promise<CandidatePreviewReadContext> {
    const snapshot = await this.deps.sources.readSceneSource({
      projectRoot: session.projectRoot,
      entryFile: session.entryFile,
      metadataFiles: session.metadataFiles
    })
    const parsed = this.deps.parser.parseSceneScript(snapshot, session.entryFile)
    const references = await this.deps.references.checkSceneAssetReferences(snapshot, parsed)
    let compatibility: CandidatePreviewReadContext['compatibility']
    try {
      compatibility = await this.deps.compatibility.readSceneCompatibility()
    } catch (error) {
      throw candidateCompatibilityFailure(error)
    }
    return {
      session,
      snapshot,
      parsed,
      references,
      issues: toCandidatePreviewIssues(parsed.diagnostics, references),
      compatibility
    }
  }

  private async resolve(request: ReadCandidatePreviewDTO): Promise<CandidatePreviewSession> {
    const resolution = await this.deps.sessions.resolveCandidatePreviewSession(request)
    if (resolution.status === 'rejected') throw candidateSessionRejection(resolution)
    return resolution.session
  }
}

function sameCandidate(left: CandidatePreviewSession, right: CandidatePreviewSession): boolean {
  return (
    left.previewSessionId === right.previewSessionId &&
    left.projectId === right.projectId &&
    left.sceneId === right.sceneId &&
    left.candidateSnapshotId === right.candidateSnapshotId &&
    left.projectRoot === right.projectRoot &&
    left.entryFile === right.entryFile
  )
}
