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
import { PREVIEW_SAVE_SOURCE_MODULE } from '@application/scene-preview/ports/PreviewSaveVersionGateway'
import {
  SceneExportErrorCodes,
  sceneExportErrorMessages
} from '@domain/scene-export/errors/SceneExportErrorCodes'

import { previewCallerOperationId } from '../scene-preview/previewSaveIdentity'
import { readPreviewSaveRecord } from '../scene-preview/previewSaveRecord'
import { resolveProjectWorkRoot } from '../project-versioning/projectWorkRoot'
import {
  resolveSceneAssetReference,
  SCENE_ASSET_RUNTIME_DIRECTORIES
} from '@infrastructure/webgal/assetPath'

export class LocalSceneExportSourceGateway implements SceneExportSourceGateway {
  constructor(
    private readonly userDirectory: string,
    private readonly versioning: ProjectVersioningApplicationService,
    private readonly sources: ScenePreviewSourceGateway
  ) {}

  async readSavedScene(request: ExportSavedSceneDTO): Promise<SavedSceneExportSource> {
    const preview = await this.sources.readScenePreviewSource(request)
    const callerOperationId = previewCallerOperationId(
      request.projectId,
      request.sceneId,
      request.versionReference.requestId
    )
    const root = await resolveProjectWorkRoot(this.userDirectory, request.projectId)
    const record = await readPreviewSaveRecord(root, callerOperationId)
    if (!record || record.projectId !== request.projectId || record.sceneId !== request.sceneId) {
      throw exportError(SceneExportErrorCodes.saveNotCommitted)
    }
    const link = await this.versioning.findCallerOperation({
      sourceModule: PREVIEW_SAVE_SOURCE_MODULE,
      callerOperationId
    })
    if (!link || link.projectId !== request.projectId || link.operationId !== record.operationId) {
      throw exportError(SceneExportErrorCodes.saveNotCommitted)
    }
    const settlement = await this.versioning.readOperationSettlement({
      projectId: request.projectId,
      operationId: record.operationId
    })
    if (settlement.state !== '已提交' && settlement.state !== '无变更') {
      throw exportError(SceneExportErrorCodes.saveNotCommitted)
    }
    if (!record.contentDigest) throw exportError(SceneExportErrorCodes.saveNotCommitted)
    if (
      preview.contentBasis.digest !== request.contentBasis.digest ||
      preview.contentBasis.digest !== record.contentDigest ||
      preview.contentBasis.parserVersion !== request.contentBasis.parserVersion ||
      preview.contentBasis.engineVersion !== request.contentBasis.engineVersion ||
      record.parserVersion !== request.contentBasis.parserVersion ||
      record.engineVersion !== request.contentBasis.engineVersion
    ) {
      throw exportError(SceneExportErrorCodes.savedContentMismatch)
    }
    const entryRelativePath = `${preview.location.sceneDirectory}/${preview.location.entryFile}`
    if (entryRelativePath !== record.relativePath || entryRelativePath.split('/').includes('..')) {
      throw exportError(SceneExportErrorCodes.savedContentMismatch)
    }
    const bytes = await readFile(path.join(preview.location.projectRoot, entryRelativePath))
    const currentDigest = createHash('sha256').update(bytes).digest('hex')
    if (currentDigest !== record.revisionDigest)
      throw exportError(SceneExportErrorCodes.savedContentMismatch)
    const assets = referencedAssets(preview.references)
    return {
      scene: { projectId: request.projectId, sceneId: request.sceneId },
      contentBasis: request.contentBasis,
      versionReference: request.versionReference,
      entryRelativePath,
      sceneText: bytes.toString('utf8'),
      referencedAssets: assets
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
