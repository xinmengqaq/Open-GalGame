import type { ProjectVersioningApplicationService } from '@application/project-versioning/services/ProjectVersioningApplicationService'
import type { CandidatePreviewSessionLookup } from '@application/scenes/ports/CandidatePreviewSessionLookup'
import { ReadCandidatePreview } from '@application/scene-preview/services/impl/ReadCandidatePreview'
import type { SceneCandidatePreviewApplicationService } from '@application/scene-preview/services/SceneCandidatePreviewApplicationService'
import { SceneAssetReferenceGatewayImpl } from '@infrastructure/scenes/SceneAssetReferenceGatewayImpl'
import { SceneScriptParserGatewayImpl } from '@infrastructure/scenes/SceneScriptParserGatewayImpl'
import { SceneSourceReaderGatewayImpl } from '@infrastructure/scenes/SceneSourceReaderGatewayImpl'
import { RegisteredSceneLocationGatewayImpl } from '@infrastructure/scenes/RegisteredSceneLocationGatewayImpl'
import { CandidatePreviewSessionGatewayImpl } from '@infrastructure/scene-preview/CandidatePreviewSessionGatewayImpl'
import { LocalPreviewSaveVersionGateway } from '@infrastructure/scene-preview/LocalPreviewSaveVersionGateway'
import { LocalSceneDialogueRevisionGateway } from '@infrastructure/scene-preview/LocalSceneDialogueRevisionGateway'
import { LocalScenePreviewSourceGateway } from '@infrastructure/scene-preview/LocalScenePreviewSourceGateway'
import { SceneCompatibilityGatewayImpl } from '@infrastructure/scene-preview/SceneCompatibilityGatewayImpl'
import { ScenePreviewArtifactGatewayImpl } from '@infrastructure/scene-preview/ScenePreviewArtifactGatewayImpl'
import type { PreviewRuntimeGateway } from '@application/scene-preview/ports/PreviewRuntimeGateway'
import { createScenePreviewApplication } from '@application/scene-preview/services/impl/createScenePreviewApplication'
import type { ScenePreviewApplicationService } from '@application/scene-preview/services/ScenePreviewApplicationService'
import { PreviewRuntimeGatewayImpl } from '@infrastructure/scene-preview/PreviewRuntimeGatewayImpl'
import { WebgalPreviewControlBridge } from '@infrastructure/webgal/preview/WebgalPreviewControlBridge'
import type { WebgalRuntimeHost } from '@infrastructure/webgal/runtime/WebgalRuntimeHostImpl'
import { randomUUID } from 'node:crypto'

export type ScenePreviewBootstrapOptions = {
  readonly userDirectory: string
  readonly versioning: ProjectVersioningApplicationService
  readonly sessionLookup: CandidatePreviewSessionLookup
  readonly now?: () => number
}

export type ScenePreviewDataServices = {
  readonly candidatePreview: SceneCandidatePreviewApplicationService
  readonly currentScene: {
    readonly artifacts: ScenePreviewArtifactGatewayImpl
    readonly sources: LocalScenePreviewSourceGateway
    readonly revisions: LocalSceneDialogueRevisionGateway
    readonly versions: LocalPreviewSaveVersionGateway
  }
}

export type ScenePreviewRuntimeOptions = ScenePreviewBootstrapOptions & {
  readonly host: WebgalRuntimeHost
  readonly bridge?: WebgalPreviewControlBridge
  readonly nextId?: () => string
}

export type ScenePreviewServices = ScenePreviewDataServices & {
  readonly currentScenePreview: ScenePreviewApplicationService
  readonly runtime: PreviewRuntimeGateway
  readonly bridge: WebgalPreviewControlBridge
}

export function createScenePreviewData(
  options: ScenePreviewBootstrapOptions
): ScenePreviewDataServices {
  const locations = new RegisteredSceneLocationGatewayImpl(options.userDirectory)
  const sources = new SceneSourceReaderGatewayImpl()
  const parser = new SceneScriptParserGatewayImpl()
  const references = new SceneAssetReferenceGatewayImpl()
  const previewSources = new LocalScenePreviewSourceGateway(locations, sources, parser, references)
  return {
    candidatePreview: new ReadCandidatePreview({
      sessions: new CandidatePreviewSessionGatewayImpl(options.sessionLookup, options.now),
      sources: new SceneSourceReaderGatewayImpl(),
      parser: new SceneScriptParserGatewayImpl(),
      references: new SceneAssetReferenceGatewayImpl(),
      compatibility: new SceneCompatibilityGatewayImpl()
    }),
    currentScene: {
      artifacts: new ScenePreviewArtifactGatewayImpl(locations, sources, parser),
      sources: previewSources,
      revisions: new LocalSceneDialogueRevisionGateway(),
      versions: new LocalPreviewSaveVersionGateway(
        options.userDirectory,
        options.versioning,
        previewSources
      )
    }
  }
}

export function createScenePreview(options: ScenePreviewRuntimeOptions): ScenePreviewServices {
  const data = createScenePreviewData(options)
  const bridge = options.bridge ?? new WebgalPreviewControlBridge(options.host)
  const runtime = new PreviewRuntimeGatewayImpl({
    host: options.host,
    bridge
  })
  return {
    ...data,
    runtime,
    bridge,
    currentScenePreview: createScenePreviewApplication({
      ...data.currentScene,
      runtime,
      nextId: options.nextId ?? randomUUID
    })
  }
}
