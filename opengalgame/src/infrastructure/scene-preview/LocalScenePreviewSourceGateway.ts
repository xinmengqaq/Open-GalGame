import type { SceneIdentity } from '@domain/scenes/models/SceneIdentity'
import type { ScenePreviewSourceGateway } from '@application/scene-preview/ports/ScenePreviewSourceGateway'
import type { ScenePreviewSourceFact } from '@application/scene-preview/models/ScenePreviewSourceFact'
import type { SceneAssetReferenceGateway } from '@application/scenes/ports/SceneAssetReferenceGateway'
import type { SceneScriptParserGateway } from '@application/scenes/ports/SceneScriptParserGateway'
import type { SceneSourceReaderGateway } from '@application/scenes/ports/SceneSourceReaderGateway'
import type { ScenePreviewLockState } from '@application/scene-preview/vo/ScenePreviewSessionVO'
import { AppException } from '@common/errors/AppException'
import { ErrorCodes } from '@common/errors/ErrorCodes'
import { RegisteredSceneLocationGatewayImpl } from '@infrastructure/scenes/RegisteredSceneLocationGatewayImpl'
import { readSceneLock } from '@infrastructure/scenes/sceneLockReader'
import { sceneReadException } from '@infrastructure/scenes/sceneReadErrors'
import {
  installedPackageVersion,
  WEBGAL_COMPATIBILITY_PROFILE
} from '@infrastructure/webgal/compatibility/WebgalCompatibilityProfile'

import { previewIssuesFromRead } from './previewIssueMapping'

const SAFE_READ_FAILURE = '当前场景内容无法读取'

/**
 * 组合正式工程定位、共享读取、解析、引用和锁定。
 * 一次返回同源事实，不写文件，不启动引擎。
 */
export class LocalScenePreviewSourceGateway implements ScenePreviewSourceGateway {
  constructor(
    private readonly locations: RegisteredSceneLocationGatewayImpl,
    private readonly sources: SceneSourceReaderGateway,
    private readonly parser: SceneScriptParserGateway,
    private readonly references: SceneAssetReferenceGateway
  ) {}

  async readScenePreviewSource(scene: SceneIdentity): Promise<ScenePreviewSourceFact> {
    const location = await this.locate(scene)
    const relativePath = `${location.sceneDirectory}/${location.entryFile}`
    let snapshot
    try {
      snapshot = await this.sources.readSceneSource({
        projectRoot: location.projectRoot,
        entryFile: relativePath
      })
    } catch (error) {
      throw safeReadFailure(error)
    }
    if (snapshot.digest.trim() === '' || snapshot.entryFile.relativePath !== relativePath) {
      throw safeReadFailure()
    }
    const parsed = this.parser.parseSceneScript(snapshot, relativePath)
    if (
      parsed.contentDigest !== snapshot.digest ||
      parsed.sourceFile.relativePath !== relativePath
    ) {
      throw safeReadFailure()
    }
    const references = await this.references.checkSceneAssetReferences(snapshot, parsed)
    const lock = await readSceneLock(location)
    const lockState = previewLockState(lock)
    const issues = [
      ...(snapshot.missingMetadataFiles.includes('.opengalgame/scene-locks.json')
        ? [{ code: 'lockMetadataMissing' as const, message: '场景锁定事实缺失' }]
        : []),
      ...previewIssuesFromRead(parsed.diagnostics, references)
    ]
    return {
      location,
      snapshot,
      parsed,
      references,
      contentBasis: {
        digest: snapshot.digest,
        parserVersion: installedPackageVersion(WEBGAL_COMPATIBILITY_PROFILE.parserPackage),
        engineVersion: installedPackageVersion(WEBGAL_COMPATIBILITY_PROFILE.enginePackage)
      },
      lockState,
      sceneName: location.entryFile.replace(/\.txt$/u, ''),
      dialogues: parsed.sentences.flatMap((sentence) => {
        if (sentence.command !== 'say' || sentence.isLineBreakHolder) return []
        return [
          {
            dialogueId: String(sentence.sequence),
            text: sentence.rawContent,
            located: sentence.contentRange !== undefined
          }
        ]
      }),
      issues
    }
  }

  private async locate(scene: SceneIdentity): Promise<ScenePreviewSourceFact['location']> {
    try {
      return await this.locations.resolveRegisteredScene(scene)
    } catch (error) {
      if (error instanceof AppException && error.code === ErrorCodes.forbidden) {
        throw new AppException({ code: ErrorCodes.forbidden, msg: '当前场景不可用', cause: error })
      }
      throw new AppException({
        code: ErrorCodes.invalidRequest,
        msg: '当前场景不可用',
        cause: error
      })
    }
  }
}

function previewLockState(lock: 'locked' | 'unlocked' | 'unknown'): ScenePreviewLockState {
  if (lock === 'unlocked') return 'editable'
  if (lock === 'locked') return 'locked'
  return 'unknown'
}

function safeReadFailure(cause?: unknown): AppException {
  return sceneReadException(
    cause instanceof AppException
      ? new AppException({ code: cause.code, msg: SAFE_READ_FAILURE, cause })
      : new AppException({ code: ErrorCodes.internalError, msg: SAFE_READ_FAILURE, cause })
  )
}
