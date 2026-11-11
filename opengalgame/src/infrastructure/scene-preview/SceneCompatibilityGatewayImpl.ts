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

/**
 * 返回当前进程固定安装的解析器和引擎版本。
 * 不读取脚本，不启动引擎，失败不沿用旧版本。
 */
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
