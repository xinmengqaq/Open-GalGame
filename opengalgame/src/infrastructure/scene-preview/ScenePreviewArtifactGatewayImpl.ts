import type { SceneIdentity } from '@domain/scenes/models/SceneIdentity'
import type {
  ScenePreviewArtifactGateway,
  ScenePreviewArtifactReport
} from '@application/scene-preview/ports/ScenePreviewArtifactGateway'
import type { SceneSourceReaderGateway } from '@application/scenes/ports/SceneSourceReaderGateway'
import type { SceneScriptParserGateway } from '@application/scenes/ports/SceneScriptParserGateway'
import { AppException } from '@common/errors/AppException'
import { ErrorCodes } from '@common/errors/ErrorCodes'
import { RegisteredSceneLocationGatewayImpl } from '@infrastructure/scenes/RegisteredSceneLocationGatewayImpl'
import { isRealWorkspaceFile } from '@infrastructure/projects/projectWorkspaceFiles'

/**
 * 只判断当前正式场景入口是否存在、非空且能解析出台词。
 * 不返回正文，不查询生成历史或提交记录。
 */
export class ScenePreviewArtifactGatewayImpl implements ScenePreviewArtifactGateway {
  constructor(
    private readonly locations: RegisteredSceneLocationGatewayImpl,
    private readonly sources: SceneSourceReaderGateway,
    private readonly parser: SceneScriptParserGateway
  ) {}

  async readSceneArtifact(scene: SceneIdentity): Promise<ScenePreviewArtifactReport> {
    let location
    try {
      location = await this.locations.resolveRegisteredScene(scene)
    } catch (error) {
      if (error instanceof AppException && error.code === ErrorCodes.invalidRequest)
        return { status: 'missing' }
      if (error instanceof AppException && error.code === ErrorCodes.forbidden)
        return { status: 'unreadable' }
      return { status: 'unreadable' }
    }
    const relativePath = `${location.sceneDirectory}/${location.entryFile}`
    let present: boolean
    try {
      present = await isRealWorkspaceFile(location.projectRoot, relativePath)
    } catch {
      return { status: 'unreadable' }
    }
    if (!present) return { status: 'missing' }
    try {
      const snapshot = await this.sources.readSceneSource({
        projectRoot: location.projectRoot,
        entryFile: relativePath,
        metadataFiles: []
      })
      if (snapshot.entryFile.size === 0 || snapshot.entryFile.text?.trim() === '')
        return { status: 'missing' }
      const parsed = this.parser.parseSceneScript(snapshot, relativePath)
      const previewable = parsed.sentences.some(
        (sentence) =>
          sentence.command === 'say' &&
          !sentence.isLineBreakHolder &&
          sentence.content.trim() !== ''
      )
      return previewable ? { status: 'available' } : { status: 'missing' }
    } catch (error) {
      if (error instanceof AppException && error.code === ErrorCodes.forbidden)
        return { status: 'unreadable' }
      return { status: 'unreadable' }
    }
  }
}
