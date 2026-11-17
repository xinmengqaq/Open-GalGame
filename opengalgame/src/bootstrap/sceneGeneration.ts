import { randomUUID } from 'node:crypto'
import { isAbsolute, join } from 'node:path'
import { RunSceneGeneration } from '@application/scene-generation/services/impl/RunSceneGeneration'
import { PreviewSceneGenerationCandidate } from '@application/scene-generation/services/impl/PreviewSceneGenerationCandidate'
import { ControlSceneGeneration } from '@application/scene-generation/services/impl/ControlSceneGeneration'
import { LaunchSceneGeneration } from '@application/scene-generation/services/impl/LaunchSceneGeneration'
import { QuerySceneGenerationRender } from '@application/scene-generation/services/impl/QuerySceneGenerationRender'
import type { SceneGenerationRenderDependencies } from '@application/scene-generation/services/impl/SceneGenerationRenderDependencies'
import { QuerySceneGenerationStatus } from '@application/scene-generation/services/impl/QuerySceneGenerationStatus'
import { QuerySceneGenerationHistory } from '@application/scene-generation/services/impl/QuerySceneGenerationHistory'
import { EditSceneGenerationCandidate } from '@application/scene-generation/services/impl/EditSceneGenerationCandidate'
import { safeFailureWithDiagnosticRef } from '@application/scene-generation/services/impl/SceneGenerationFailureFacts'
import { ClearSceneGenerationMemory } from '@application/scene-generation/services/impl/ClearSceneGenerationMemory'
import {
  SceneGenerationCoordinator,
  type SceneGenerationDependencies,
  type SceneGenerationDispatchIdentity
} from '@application/scene-generation/services/impl/SceneGenerationCoordinator'
import type { ConnectionSettingsInfo } from '@domain/connections/models/ConnectionSettings'
import { SceneGenerationDomainServiceImpl } from '@domain/scene-generation/services/impl/SceneGenerationDomainServiceImpl'
import type { SceneGenerationProgressVO } from '@application/scene-generation/vo/SceneGenerationVO'
import {
  SceneInputGatewayImpl,
  type SceneGenerationRegistration
} from '@infrastructure/scene-generation/inputs/SceneInputGatewayImpl'
import { FileSceneGenerationExecutionRepositoryImpl } from '@infrastructure/scene-generation/execution/FileSceneGenerationExecutionRepositoryImpl'
import { WebGalSceneGenerationWorkspaceGatewayImpl } from '@infrastructure/scene-generation/artifacts/WebGalSceneGenerationWorkspaceGatewayImpl'
import { WebGalSceneArtifactGatewayImpl } from '@infrastructure/scene-generation/artifacts/WebGalSceneArtifactGatewayImpl'
import { SceneVersionGatewayImpl } from '@infrastructure/scene-generation/versions/SceneVersionGatewayImpl'
import { WebGalSceneGenerationWorkflowImpl } from '@infrastructure/scene-generation/workflow/WebGalSceneGenerationWorkflowImpl'
import { WebGalSceneGenerationHistoryReaderImpl } from '@infrastructure/scene-generation/history/WebGalSceneGenerationHistoryReaderImpl'
import { SceneGenerationMemoryGatewayImpl } from '@infrastructure/scene-generation/memory/SceneGenerationMemoryGatewayImpl'
import { WebGalSceneAgentImpl } from '@infrastructure/scene-generation/agents/WebGalSceneAgentImpl'
import { LangChainAgentFactoryImpl } from '@infrastructure/ai/factories/LangChainAgentFactoryImpl'
import { LangChainModelFactory } from '@infrastructure/ai/models/LangChainModelFactory'
import { FilePromptLoader } from '@infrastructure/ai/prompts/FilePromptLoader'
import { AiProjectFileSystemImpl } from '@infrastructure/ai/filesystem/AiProjectFileSystemImpl'
import type { ProjectVersioningApplicationService } from '@application/project-versioning/services/ProjectVersioningApplicationService'
import type { ProjectApplicationService } from '@application/projects/services/ProjectApplicationService'
import { WebGalGenerationCheckpointSaver } from '@infrastructure/scene-generation/history/WebGalGenerationCheckpoint'
import { SceneSourceReaderGatewayImpl } from '@infrastructure/scenes/SceneSourceReaderGatewayImpl'
import { SceneScriptParserGatewayImpl } from '@infrastructure/scenes/SceneScriptParserGatewayImpl'
import { SceneAssetReferenceGatewayImpl } from '@infrastructure/scenes/SceneAssetReferenceGatewayImpl'
import { AppException } from '@common/errors/AppException'
import { ErrorCodes } from '@common/errors/ErrorCodes'
import { CanvasArrangementMigration } from '@infrastructure/scene-canvas/migration/CanvasArrangementMigration'
import { assertUserDirectory } from './userDirectory'

export type SceneGenerationBootstrapOptions = {
  userStateRoot: string
  promptRoot: string
  registrations?: readonly SceneGenerationRegistration[]
  loadSettings: () => Promise<ConnectionSettingsInfo | null>
  fetcher?: typeof fetch
  dispatch: (job: () => Promise<void>, identity: SceneGenerationDispatchIdentity) => void
  publishProgress: (event: SceneGenerationProgressVO) => void
  versioning: ProjectVersioningApplicationService
  projects: Pick<ProjectApplicationService, 'ensureProjectWorkspace'>
  render?: SceneGenerationRenderDependencies
}

export type SceneGenerationServices = {
  generation: RunSceneGeneration
  launch?: LaunchSceneGeneration
  renderQuery?: QuerySceneGenerationRender
  control?: ControlSceneGeneration
  candidatePreview?: PreviewSceneGenerationCandidate
  status: QuerySceneGenerationStatus
  history: QuerySceneGenerationHistory
  candidateEdit: EditSceneGenerationCandidate
  memory: ClearSceneGenerationMemory
  close: () => Promise<void>
  ports: {
    input: SceneInputGatewayImpl
    executions: FileSceneGenerationExecutionRepositoryImpl
    workspace: WebGalSceneGenerationWorkspaceGatewayImpl
    artifacts: WebGalSceneArtifactGatewayImpl
    versions: SceneVersionGatewayImpl
    workflow: WebGalSceneGenerationWorkflowImpl
    history: WebGalSceneGenerationHistoryReaderImpl
    memory: SceneGenerationMemoryGatewayImpl
  }
}

/** 装配生成服务与端口。IPC 由 home.ts 注册；本函数不创建页面、HTTP 或通用 IPC。 */
export async function createSceneGeneration(
  options: SceneGenerationBootstrapOptions
): Promise<SceneGenerationServices> {
  assertUserDirectory(options.userStateRoot)
  if (![options.userStateRoot, options.promptRoot].every(isAbsolute))
    throw new AppException({
      code: ErrorCodes.invalidConfig,
      msg: '生成状态与资源根必须为绝对路径'
    })
  const stateRoot = join(options.userStateRoot, 'ai')
  const files = new AiProjectFileSystemImpl(options.userStateRoot)
  const saver = new WebGalGenerationCheckpointSaver(stateRoot)
  const canvasMigration = new CanvasArrangementMigration({
    backupRoot: join(options.userStateRoot, 'migrations', 'scene-canvas')
  })
  const input = new SceneInputGatewayImpl(
    options.registrations ?? [],
    canvasMigration,
    options.render?.production
  )
  const executions = new FileSceneGenerationExecutionRepositoryImpl(options.userStateRoot)
  const workspace = new WebGalSceneGenerationWorkspaceGatewayImpl(files)
  /** 领域服务无状态，实例身份不参与判定；组合根注入同一实例。 */
  const domain = new SceneGenerationDomainServiceImpl()
  const artifacts = new WebGalSceneArtifactGatewayImpl(
    files,
    new SceneSourceReaderGatewayImpl(),
    new SceneScriptParserGatewayImpl(),
    new SceneAssetReferenceGatewayImpl(),
    domain
  )
  const versions = new SceneVersionGatewayImpl(options.versioning, options.projects)
  const factory = new LangChainAgentFactoryImpl(
    new LangChainModelFactory(options.loadSettings, options.fetcher),
    new FilePromptLoader(options.promptRoot)
  )
  const agentImplementation = WebGalSceneAgentImpl
  const graphDependencies = { saver, stateRoot, artifacts, domain }
  /** 模型连接可在启动后配置；装配阶段不创建需要已存设置的智能体。 */
  const workflow = new WebGalSceneGenerationWorkflowImpl(
    graphDependencies,
    files,
    () =>
      factory.create(agentImplementation, {
        model: { override: { requestTimeoutMs: undefined } },
        override: { toolTimeoutMs: undefined }
      }),
    safeFailureWithDiagnosticRef
  )
  const history = new WebGalSceneGenerationHistoryReaderImpl(graphDependencies, files, executions)
  const memory = new SceneGenerationMemoryGatewayImpl(stateRoot, executions)
  const dependencies: SceneGenerationDependencies = {
    domain,
    input,
    executions,
    workspace,
    artifacts,
    versions,
    workflow,
    history,
    memory,
    workflowControl: workflow,
    candidatePreview: options.render?.preview,
    nextId: randomUUID,
    now: Date.now,
    dispatch: options.dispatch,
    publishProgress: options.publishProgress
  }
  const coordinator = new SceneGenerationCoordinator(dependencies)
  const generation = new RunSceneGeneration(dependencies, coordinator)
  const launch = options.render
    ? new LaunchSceneGeneration(dependencies, options.render, generation, coordinator)
    : undefined
  return {
    generation,
    ...(launch ? { launch } : {}),
    ...(options.render
      ? {
          renderQuery: new QuerySceneGenerationRender(dependencies, coordinator),
          control: new ControlSceneGeneration(dependencies, coordinator, generation),
          candidatePreview: new PreviewSceneGenerationCandidate(
            dependencies,
            options.render,
            coordinator
          )
        }
      : {}),
    status: new QuerySceneGenerationStatus(dependencies, coordinator),
    history: new QuerySceneGenerationHistory(history, executions),
    candidateEdit: new EditSceneGenerationCandidate(
      dependencies,
      coordinator,
      options.render?.preview
    ),
    memory: new ClearSceneGenerationMemory(dependencies, coordinator),
    close: async () => {
      await options.render?.preview.close?.()
    },
    ports: { input, executions, workspace, artifacts, versions, workflow, history, memory }
  }
}
