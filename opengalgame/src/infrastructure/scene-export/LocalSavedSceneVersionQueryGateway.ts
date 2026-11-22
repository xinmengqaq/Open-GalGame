import { createHash } from 'node:crypto'
import { stat } from 'node:fs/promises'
import { join } from 'node:path'

import type { ProjectVersioningApplicationService } from '@application/project-versioning/services/ProjectVersioningApplicationService'
import type {
  SavedSceneVersionCandidate,
  SavedSceneVersionQueryGateway
} from '@application/scene-export/ports/SavedSceneVersionQueryGateway'
import type { ReadLatestSavedSceneVersionDTO } from '@application/scene-export/dto/ReadLatestSavedSceneVersionDTO'
import type { SceneExportContentBasis } from '@application/scene-export/vo/SceneExportContentBasis'
import type { ScenePreviewSourceGateway } from '@application/scene-preview/ports/ScenePreviewSourceGateway'
import { WEBGAL_AUDITED_VERSION } from '@common/config/WebgalVersion'

import { resolveRepositoryMetadata } from '../git/containedPath'
import { resolveProjectWorkRoot } from '../project-versioning/projectWorkRoot'
import { listVersionDocuments } from '../project-versioning/versionStore'
import { listCallerIntentsAt } from '../project-versioning/FileVersionOperationRecordGateway'
import {
  PREVIEW_SAVE_DIRECTORY,
  readPreviewSaveRecord
} from '../scene-preview/previewSaveRecord'
import { readPreviewSaveAuthority } from '../scene-preview/previewSaveAuthority'
import { verifyGenerationCommit } from './generationCommitVerification'

const GENERATION_SOURCE_MODULE = 'scene-generation'

/**
 * 汇总当前场景仍可导出的预览保存和生成提交。
 * 只有当前正式场景字节、入口路径、结算和来源都能核对时才产生候选。
 */
export class LocalSavedSceneVersionQueryGateway implements SavedSceneVersionQueryGateway {
  constructor(
    private readonly userDirectory: string,
    private readonly versioning: ProjectVersioningApplicationService,
    private readonly sources: ScenePreviewSourceGateway
  ) {}

  async listExportableSavedSceneVersions(
    request: ReadLatestSavedSceneVersionDTO
  ): Promise<readonly SavedSceneVersionCandidate[]> {
    const preview = await this.sources
      .readScenePreviewSource({ projectId: request.projectId, sceneId: request.sceneId })
      .catch(() => null)
    if (!preview) return []
    const contentBasis = preview.contentBasis
    if (
      contentBasis.digest.trim() === '' ||
      contentBasis.parserVersion !== WEBGAL_AUDITED_VERSION ||
      contentBasis.engineVersion !== WEBGAL_AUDITED_VERSION
    ) {
      return []
    }
    const entryRelativePath = `${preview.location.sceneDirectory}/${preview.location.entryFile}`
    if (entryRelativePath.split('/').includes('..')) return []
    const entry = preview.snapshot.files.find(
      (file) => file.relativePath === entryRelativePath
    )
    if (!entry || entry.relativePath !== entryRelativePath) return []
    const currentDigest = createHash('sha256').update(entry.bytes).digest('hex')
    const root = await resolveProjectWorkRoot(this.userDirectory, request.projectId)
    const candidates: SavedSceneVersionCandidate[] = []

    await this.collectPreviewSaves(
      request,
      root,
      entryRelativePath,
      currentDigest,
      contentBasis,
      candidates
    )
    await this.collectGenerationCommits(
      request,
      root,
      entryRelativePath,
      currentDigest,
      contentBasis,
      candidates
    )
    return candidates
  }

  private async collectPreviewSaves(
    request: ReadLatestSavedSceneVersionDTO,
    root: string,
    entryRelativePath: string,
    currentDigest: string,
    contentBasis: SceneExportContentBasis,
    candidates: SavedSceneVersionCandidate[]
  ): Promise<void> {
    const directory = await resolveRepositoryMetadata(root, PREVIEW_SAVE_DIRECTORY).catch(
      () => null
    )
    if (!directory) return
    const names = await listVersionDocuments(directory).catch(() => [])
    for (const name of names) {
      if (!name.endsWith('.json')) continue
      const callerOperationId = name.slice(0, -'.json'.length)
      const stored = await readPreviewSaveRecord(root, callerOperationId).catch(() => null)
      if (!stored) continue
      const authority = await readPreviewSaveAuthority({
        root,
        versioning: this.versioning,
        projectId: request.projectId,
        sceneId: request.sceneId,
        requestId: stored.requestId
      }).catch(() => null)
      if (!authority || authority.callerOperationId !== callerOperationId) continue
      const record = authority.record
      if (
        record.refusal !== undefined ||
        record.contentDigest === undefined ||
        record.contentDigest !== contentBasis.digest ||
        record.parserVersion !== contentBasis.parserVersion ||
        record.engineVersion !== contentBasis.engineVersion ||
        record.relativePath !== entryRelativePath ||
        record.revisionDigest !== currentDigest
      ) {
        continue
      }
      const metadata = await stat(join(directory, name)).catch(() => null)
      if (!metadata) continue
      candidates.push({
        projectId: request.projectId,
        sceneId: request.sceneId,
        versionReference: { kind: 'preview-save', requestId: record.requestId },
        revisionDigest: record.revisionDigest,
        contentBasis,
        savedAtMs: metadata.mtimeMs
      })
    }
  }

  private async collectGenerationCommits(
    request: ReadLatestSavedSceneVersionDTO,
    root: string,
    entryRelativePath: string,
    currentDigest: string,
    contentBasis: SceneExportContentBasis,
    candidates: SavedSceneVersionCandidate[]
  ): Promise<void> {
    const links = await listCallerIntentsAt(root, request.projectId, GENERATION_SOURCE_MODULE).catch(
      () => []
    )
    for (const link of links) {
      const verified = await verifyGenerationCommit({
        root,
        versioning: this.versioning,
        projectId: request.projectId,
        sceneId: request.sceneId,
        entryRelativePath,
        currentEntryDigest: currentDigest,
        operationId: link.callerOperationId
      }).catch(() => null)
      if (!verified || verified.state !== 'verified') continue
      candidates.push({
        projectId: request.projectId,
        sceneId: request.sceneId,
        versionReference: {
          kind: 'generation-commit',
          operationId: verified.operationId,
          commitId: verified.commitId
        },
        revisionDigest: currentDigest,
        contentBasis,
        savedAtMs: verified.savedAtMs
      })
    }
  }
}
