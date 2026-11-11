import { AppException } from '@common/errors/AppException'
import {
  SceneExportErrorCodes,
  sceneExportErrorMessages
} from '@domain/scene-export/errors/SceneExportErrorCodes'

import type { ExportSavedSceneDTO } from '../../dto/ExportSavedSceneDTO'
import type { SavedSceneExportSource } from '../../ports/SceneExportSourceGateway'
import type { SceneExportSourceGateway } from '../../ports/SceneExportSourceGateway'
import type {
  WindowsScenePackageResult,
  WindowsScenePackager
} from '../../ports/WindowsScenePackager'
import type { SceneExportApplicationService } from '../SceneExportApplicationService'
import type { SceneExportResultVO, WindowsScenePackageVO } from '../../vo/SceneExportVO'

export interface SceneExportApplicationDependencies {
  readonly sources: SceneExportSourceGateway
  readonly packager: WindowsScenePackager
}

const allowedKeys: Record<string, true> = {
  projectId: true,
  sceneId: true,
  contentBasis: true,
  versionReference: true
}

export class SceneExportApplicationServiceImpl implements SceneExportApplicationService {
  private readonly completed = new Map<string, WindowsScenePackageVO>()
  private readonly running = new Map<string, Promise<SceneExportResultVO>>()

  constructor(private readonly deps: SceneExportApplicationDependencies) {}

  async exportSavedScene(request: ExportSavedSceneDTO): Promise<SceneExportResultVO> {
    rejectForeignInput(request)
    const source = await this.deps.sources.readSavedScene(request)
    if (
      source.contentBasis.digest !== request.contentBasis.digest ||
      source.versionReference.requestId !== request.versionReference.requestId
    ) {
      throw new AppException({
        code: SceneExportErrorCodes.savedContentMismatch,
        msg: sceneExportErrorMessages[SceneExportErrorCodes.savedContentMismatch]
      })
    }
    const identity = JSON.stringify({
      projectId: source.scene.projectId,
      sceneId: source.scene.sceneId,
      digest: source.contentBasis.digest,
      requestId: source.versionReference.requestId
    })
    const previous = this.completed.get(identity)
    if (previous) return { status: 'succeeded', artifact: previous }
    const current = this.running.get(identity)
    if (current) return current
    const task = this.packageSaved(identity, source)
    this.running.set(identity, task)
    try {
      return await task
    } finally {
      this.running.delete(identity)
    }
  }

  private async packageSaved(
    identity: string,
    source: SavedSceneExportSource
  ): Promise<SceneExportResultVO> {
    const packaged = await this.deps.packager.packageWindowsScene(source)
    if (packaged.status === 'succeeded') {
      const artifact = packaged.artifact
      const matches =
        artifact.executableName === 'WebGAL.exe' &&
        artifact.bytes > 0 &&
        artifact.containsFixedEngine &&
        artifact.entryRelativePath === source.entryRelativePath &&
        artifact.contentBasis.digest === source.contentBasis.digest &&
        artifact.versionReference.requestId === source.versionReference.requestId
      if (!matches)
        return {
          status: 'failed',
          message: sceneExportErrorMessages[SceneExportErrorCodes.exportFailed]
        }
      this.completed.set(identity, artifact)
      return { status: 'succeeded', artifact }
    }
    return exportResult(packaged)
  }
}

function rejectForeignInput(request: ExportSavedSceneDTO): void {
  const basis = request.contentBasis
  const reference = request.versionReference
  const foreign = Object.keys(request).find((key) => allowedKeys[key] !== true)
  const basisForeign = basis
    ? Object.keys(basis).find(
        (key) => key !== 'digest' && key !== 'parserVersion' && key !== 'engineVersion'
      )
    : 'missing'
  const referenceForeign = reference
    ? Object.keys(reference).find((key) => key !== 'kind' && key !== 'requestId')
    : 'missing'
  if (
    request.projectId.trim() === '' ||
    request.sceneId.trim() === '' ||
    foreign !== undefined ||
    basisForeign !== undefined ||
    referenceForeign !== undefined ||
    reference.kind !== 'preview-save' ||
    reference.requestId.trim() === '' ||
    basis.digest.trim() === '' ||
    basis.parserVersion !== '4.6.5' ||
    basis.engineVersion !== '4.6.5'
  ) {
    throw new AppException({
      code: SceneExportErrorCodes.exportInputRejected,
      msg: sceneExportErrorMessages[SceneExportErrorCodes.exportInputRejected]
    })
  }
}

function exportResult(
  packaged: Exclude<WindowsScenePackageResult, { status: 'succeeded' }>
): SceneExportResultVO {
  if (packaged.status === 'unavailable') {
    return { status: 'unavailable', reason: packaged.reason, message: packaged.message }
  }
  return { status: 'failed', message: packaged.message }
}
