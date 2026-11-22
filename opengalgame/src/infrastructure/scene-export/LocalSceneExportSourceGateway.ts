import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'

import { AppException } from '@common/errors/AppException'
import type { ExportSavedSceneDTO } from '@application/scene-export/dto/ExportSavedSceneDTO'
import type {
  SavedSceneExportSource,
  SavedSceneReferencedAsset,
  SceneExportSourceGateway
} from '@application/scene-export/ports/SceneExportSourceGateway'
import type { ScenePreviewSourceFact } from '@application/scene-preview/models/ScenePreviewSourceFact'
import type { ProjectVersioningApplicationService } from '@application/project-versioning/services/ProjectVersioningApplicationService'
import type { ScenePreviewSourceGateway } from '@application/scene-preview/ports/ScenePreviewSourceGateway'
import {
  SceneExportErrorCodes,
  sceneExportErrorMessages
} from '@domain/scene-export/errors/SceneExportErrorCodes'

import { readPreviewSaveAuthority } from '../scene-preview/previewSaveAuthority'
import { resolveProjectWorkRoot } from '../project-versioning/projectWorkRoot'
import {
  resolveSceneAssetReference,
  SCENE_ASSET_RUNTIME_DIRECTORIES
} from '@infrastructure/webgal/assetPath'
import { verifyGenerationCommit } from './generationCommitVerification'

export class LocalSceneExportSourceGateway implements SceneExportSourceGateway {
  constructor(
    private readonly userDirectory: string,
    private readonly versioning: ProjectVersioningApplicationService,
    private readonly sources: ScenePreviewSourceGateway
  ) {}

  async readSavedScene(request: ExportSavedSceneDTO): Promise<SavedSceneExportSource> {
    const preview = await this.sources.readScenePreviewSource(request)
    const root = await resolveProjectWorkRoot(this.userDirectory, request.projectId)
    const contentBasis = preview.contentBasis
    const entryRelativePath = `${preview.location.sceneDirectory}/${preview.location.entryFile}`
    if (entryRelativePath.split('/').includes('..')) {
      throw exportError(SceneExportErrorCodes.savedContentMismatch)
    }
    const bytes = await readFile(path.join(preview.location.projectRoot, entryRelativePath))
    const currentDigest = createHash('sha256').update(bytes).digest('hex')

    if (request.versionReference.kind === 'preview-save') {
      await this.requirePreviewSave(
        request,
        root,
        preview,
        entryRelativePath,
        currentDigest
      )
    } else {
      const verified = await verifyGenerationCommit({
        root,
        versioning: this.versioning,
        projectId: request.projectId,
        sceneId: request.sceneId,
        entryRelativePath,
        currentEntryDigest: currentDigest,
        operationId: request.versionReference.operationId,
        expectedCommitId: request.versionReference.commitId
      })
      if (verified.state === 'contentMismatch') {
        throw exportError(SceneExportErrorCodes.savedContentMismatch)
      }
      if (verified.state !== 'verified') {
        throw exportError(SceneExportErrorCodes.saveNotCommitted)
      }
    }

    if (
      contentBasis.digest !== request.contentBasis.digest ||
      contentBasis.parserVersion !== request.contentBasis.parserVersion ||
      contentBasis.engineVersion !== request.contentBasis.engineVersion
    ) {
      throw exportError(SceneExportErrorCodes.savedContentMismatch)
    }

    const assets = referencedAssets(preview.references)
    return {
      scene: { projectId: request.projectId, sceneId: request.sceneId },
      contentBasis,
      versionReference: request.versionReference,
      entryRelativePath,
      entrySha256: currentDigest,
      sceneText: bytes.toString('utf8'),
      referencedAssets: assets
    }
  }

  private async requirePreviewSave(
    request: ExportSavedSceneDTO,
    root: string,
    preview: ScenePreviewSourceFact,
    entryRelativePath: string,
    currentDigest: string
  ): Promise<void> {
    if (request.versionReference.kind !== 'preview-save') {
      throw exportError(SceneExportErrorCodes.exportInputRejected)
    }
    const authority = await readPreviewSaveAuthority({
      root,
      versioning: this.versioning,
      projectId: request.projectId,
      sceneId: request.sceneId,
      requestId: request.versionReference.requestId
    })
    if (!authority) throw exportError(SceneExportErrorCodes.saveNotCommitted)
    const record = authority.record
    if (!record.contentDigest) throw exportError(SceneExportErrorCodes.saveNotCommitted)
    if (
      preview.contentBasis.digest !== record.contentDigest ||
      preview.contentBasis.parserVersion !== record.parserVersion ||
      preview.contentBasis.engineVersion !== record.engineVersion ||
      record.relativePath !== entryRelativePath ||
      record.revisionDigest !== currentDigest
    ) {
      throw exportError(SceneExportErrorCodes.savedContentMismatch)
    }
  }

}

function exportError(
  code: (typeof SceneExportErrorCodes)[keyof typeof SceneExportErrorCodes]
): AppException {
  return new AppException({ code, msg: sceneExportErrorMessages[code] })
}
function referencedAssets(
  references: ScenePreviewSourceFact['references']
): SavedSceneReferencedAsset[] {
  const assets: SavedSceneReferencedAsset[] = []
  const seen = new Set<string>()
  for (const reference of references) {
    if (reference.status === 'cleared' || reference.status === 'external') continue
    if (
      reference.status !== 'present' ||
      !reference.relativePath ||
      !(SCENE_ASSET_RUNTIME_DIRECTORIES as readonly string[]).includes(reference.kind)
    ) {
      throw exportError(SceneExportErrorCodes.exportFailed)
    }
    const resolved = resolveSceneAssetReference({
      sourcePath: reference.runtimeReference.replace(/^\.\//u, ''),
      runtimeDirectory: reference.kind
    })
    const sourcePath = reference.relativePath.replaceAll('\\', '/')
    if (seen.has(`${sourcePath}\0${resolved.canonicalPath}`)) continue
    seen.add(`${sourcePath}\0${resolved.canonicalPath}`)
    assets.push({ sourcePath, packagePath: resolved.canonicalPath })
  }
  return assets
}
