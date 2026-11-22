import { WEBGAL_AUDITED_VERSION } from '@common/config/WebgalVersion'
import { OPERATION_ID_PATTERN } from '@common/contracts/OperationId'
import { AppException } from '@common/errors/AppException'
import {
  SceneExportErrorCodes,
  sceneExportErrorMessages
} from '@domain/scene-export/errors/SceneExportErrorCodes'

import type {
  ExportSavedSceneDTO,
  SceneExportDestinationDTO
} from '../../dto/ExportSavedSceneDTO'
import type {
  SceneExportDestination,
  SceneExportDestinationGateway
} from '../../ports/SceneExportDestinationGateway'
import type {
  SavedSceneExportSource,
  SceneExportSourceGateway
} from '../../ports/SceneExportSourceGateway'
import type {
  WindowsScenePackageResult,
  WindowsScenePackager
} from '../../ports/WindowsScenePackager'
import type { SceneExportApplicationService } from '../SceneExportApplicationService'
import type {
  SceneExportResultVO,
  SceneExportVersionReference,
  WindowsScenePackageVO
} from '../../vo/SceneExportVO'
import {
  sameSceneExportVersion,
  sceneExportVersionKey
} from '../sceneExportVersion'

export interface SceneExportApplicationDependencies {
  readonly sources: SceneExportSourceGateway
  readonly destinations: SceneExportDestinationGateway
  readonly packager: WindowsScenePackager
}

const allowedKeys: Record<string, true> = {
  projectId: true,
  sceneId: true,
  contentBasis: true,
  versionReference: true,
  destination: true
}

const commitIdPattern = /^[0-9a-f]{40}$/u
const selectionIdPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u

export class ExportSavedScene implements SceneExportApplicationService {
  private readonly completed = new Map<string, WindowsScenePackageVO>()
  private readonly running = new Map<string, Promise<SceneExportResultVO>>()

  constructor(private readonly deps: SceneExportApplicationDependencies) {}

  async exportSavedScene(request: ExportSavedSceneDTO): Promise<SceneExportResultVO> {
    rejectForeignInput(request)
    const destinationIntent = destinationOf(request.destination)
    const source = await this.deps.sources.readSavedScene(request)
    if (
      source.contentBasis.digest !== request.contentBasis.digest ||
      !sameSceneExportVersion(source.versionReference, request.versionReference)
    ) {
      throw new AppException({
        code: SceneExportErrorCodes.savedContentMismatch,
        msg: sceneExportErrorMessages[SceneExportErrorCodes.savedContentMismatch]
      })
    }
    const destination = await this.deps.destinations.resolveDestination(
      source.scene,
      destinationIntent
    )
    const identity = JSON.stringify({
      projectId: source.scene.projectId,
      sceneId: source.scene.sceneId,
      digest: source.contentBasis.digest,
      version: sceneExportVersionKey(source.versionReference),
      destination: `${destination.kind}\u0000${destination.parentDirectory}`
    })
    const previous = this.completed.get(identity)
    if (previous && (await this.artifactStillCurrent(source, destination, previous))) {
      return { status: 'succeeded', artifact: previous }
    }
    if (previous) this.completed.delete(identity)
    const current = this.running.get(identity)
    if (current) return current
    const task = this.packageSaved(identity, source, destination)
    this.running.set(identity, task)
    try {
      return await task
    } finally {
      this.running.delete(identity)
    }
  }

  /** 缓存命中也要回到真实目录核对；产物被删除或改写不会返回过期成功。 */
  private async artifactStillCurrent(
    source: SavedSceneExportSource,
    destination: SceneExportDestination,
    artifact: WindowsScenePackageVO
  ): Promise<boolean> {
    try {
      return await this.deps.packager.verifyWindowsScene(source, destination, artifact)
    } catch {
      return false
    }
  }

  private async packageSaved(
    identity: string,
    source: SavedSceneExportSource,
    destination: SceneExportDestination
  ): Promise<SceneExportResultVO> {
    const packaged = await this.deps.packager.packageWindowsScene(source, destination)
    if (packaged.status === 'succeeded') {
      const artifact = packaged.artifact
      const matches =
        artifact.executableName === 'WebGAL.exe' &&
        artifact.bytes > 0 &&
        artifact.containsFixedEngine &&
        artifact.entryRelativePath === source.entryRelativePath &&
        artifact.contentBasis.digest === source.contentBasis.digest &&
        sameSceneExportVersion(artifact.versionReference, source.versionReference)
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

function destinationOf(
  destination: SceneExportDestinationDTO | undefined
): SceneExportDestinationDTO {
  if (destination === undefined) return { kind: 'workspace' }
  if (typeof destination !== 'object' || destination === null) {
    throw rejectedInput()
  }
  const keys = Object.keys(destination)
  if (destination.kind === 'workspace') {
    if (keys.length !== 1 || !keys.includes('kind')) throw rejectedInput()
    return { kind: 'workspace' }
  }
  if (destination.kind === 'selected') {
    if (
      keys.length !== 2 ||
      !keys.includes('kind') ||
      !keys.includes('selectionId') ||
      !selectionIdPattern.test(destination.selectionId)
    ) {
      throw rejectedInput()
    }
    return { kind: 'selected', selectionId: destination.selectionId }
  }
  throw rejectedInput()
}

function rejectedInput(): AppException {
  return new AppException({
    code: SceneExportErrorCodes.exportInputRejected,
    msg: sceneExportErrorMessages[SceneExportErrorCodes.exportInputRejected]
  })
}

function rejectForeignInput(request: ExportSavedSceneDTO): void {
  const basis = request.contentBasis
  const foreign = Object.keys(request).find((key) => allowedKeys[key] !== true)
  const basisForeign = basis
    ? Object.keys(basis).find(
        (key) => key !== 'digest' && key !== 'parserVersion' && key !== 'engineVersion'
      )
    : 'missing'
  if (
    request.projectId.trim() === '' ||
    request.sceneId.trim() === '' ||
    foreign !== undefined ||
    basisForeign !== undefined ||
    invalidReference(request.versionReference) ||
    basis.digest.trim() === '' ||
    basis.parserVersion !== WEBGAL_AUDITED_VERSION ||
    basis.engineVersion !== WEBGAL_AUDITED_VERSION
  ) {
    throw rejectedInput()
  }
}

/** 版本引用只接受两种已知形状；未知 kind、额外字段或空身份都拒绝。 */
function invalidReference(reference: SceneExportVersionReference): boolean {
  if (typeof reference !== 'object' || reference === null) return true
  const keys = Object.keys(reference)
  if (reference.kind === 'preview-save') {
    return (
      keys.length !== 2 ||
      !keys.includes('kind') ||
      !keys.includes('requestId') ||
      reference.requestId.trim() === ''
    )
  }
  if (reference.kind === 'generation-commit') {
    return (
      keys.length !== 3 ||
      !keys.includes('operationId') ||
      !keys.includes('commitId') ||
      !OPERATION_ID_PATTERN.test(reference.operationId) ||
      !commitIdPattern.test(reference.commitId)
    )
  }
  return true
}

function exportResult(
  packaged: Exclude<WindowsScenePackageResult, { status: 'succeeded' }>
): SceneExportResultVO {
  if (packaged.status === 'unavailable') {
    return { status: 'unavailable', reason: packaged.reason, message: packaged.message }
  }
  return { status: 'failed', message: packaged.message }
}
