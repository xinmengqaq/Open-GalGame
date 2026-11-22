import type { SceneCompatibilityGateway } from '@application/scene-preview/ports/SceneCompatibilityGateway'
import type { SceneCompatibilityFacts } from '@application/scene-preview/models/SceneCompatibilityFacts'
import { AppException } from '@common/errors/AppException'
import {
  ScenePreviewErrorCodes,
  scenePreviewErrorMessages
} from '@domain/scene-preview/errors/ScenePreviewErrorCodes'
import {
  installedPackageVersion,
  WEBGAL_COMPATIBILITY_PROFILE
} from '@infrastructure/webgal/compatibility/WebgalCompatibilityProfile'

export class SceneCompatibilityGatewayImpl implements SceneCompatibilityGateway {
  async readSceneCompatibility(): Promise<SceneCompatibilityFacts> {
    try {
      return {
        parserVersion: installedPackageVersion(WEBGAL_COMPATIBILITY_PROFILE.parserPackage),
        engineVersion: installedPackageVersion(WEBGAL_COMPATIBILITY_PROFILE.enginePackage)
      }
    } catch (error) {
      throw new AppException({
        code: ScenePreviewErrorCodes.candidateCompatibilityUnavailable,
        msg: scenePreviewErrorMessages[ScenePreviewErrorCodes.candidateCompatibilityUnavailable],
        cause: error
      })
    }
  }
}
