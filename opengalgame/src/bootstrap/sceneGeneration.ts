import { randomUUID } from 'node:crypto'
import { isAbsolute, join } from 'node:path'
import { SceneGenerationApplicationServiceImpl } from '@application/scene-generation/services/impl/SceneGenerationApplicationServiceImpl'
import { SceneGenerationCandidatePreviewServiceImpl } from '@application/scene-generation/services/impl/SceneGenerationCandidatePreviewServiceImpl'
import { SceneGenerationControlServiceImpl } from '@application/scene-generation/services/impl/SceneGenerationControlServiceImpl'
import { SceneGenerationLaunchServiceImpl } from '@application/scene-generation/services/impl/SceneGenerationLaunchServiceImpl'
import { SceneGenerationRenderQueryServiceImpl } from '@application/scene-generation/services/impl/SceneGenerationRenderQueryServiceImpl'
import type { SceneGenerationRenderDependencies } from '@application/scene-generation/services/impl/SceneGenerationRenderDependencies'
import { SceneGenerationStatusQueryServiceImpl } from '@application/scene-generation/services/impl/SceneGenerationStatusQueryServiceImpl'
import { SceneGenerationHistoryQueryServiceImpl } from '@application/scene-generation/services/impl/SceneGenerationHistoryQueryServiceImpl'
import { SceneGenerationCandidateEditServiceImpl } from '@application/scene-generation/services/impl/SceneGenerationCandidateEditServiceImpl'
import { SceneGenerationMemoryServiceImpl } from '@application/scene-generation/services/impl/SceneGenerationMemoryServiceImpl'
import {
  SceneGenerationCoordinator,
  type SceneGenerationDependencies,
  type SceneGenerationDispatchIdentity
} from '@application/scene-generation/services/impl/SceneGenerationCoordinator'
import type { ConnectionSettingsInfo } from '@domain/connections/models/ConnectionSettings'
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
  generation: SceneGenerationApplicationServiceImpl
  launch?: SceneGenerationLaunchServiceImpl
  renderQuery?: SceneGenerationRenderQueryServiceImpl
  control?: SceneGenerationControlServiceImpl
  candidatePreview?: SceneGenerationCandidatePreviewServiceImpl
  status: SceneGenerationStatusQueryServiceImpl
  history: SceneGenerationHistoryQueryServiceImpl
  candidateEdit: SceneGenerationCandidateEditServiceImpl
  memory: SceneGenerationMemoryServiceImpl
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
  const input = new SceneInputGatewayImpl(options.registrations ?? [], options.render?.production)
  const executions = new FileSceneGenerationExecutionRepositoryImpl(options.userStateRoot)
  const workspace = new WebGalSceneGenerationWorkspaceGatewayImpl(files)
  const artifacts = new WebGalSceneArtifactGatewayImpl(
    files,
    new SceneSourceReaderGatewayImpl(),
    new SceneScriptParserGatewayImpl(),
    new SceneAssetReferenceGatewayImpl()
  )
  const versions = new SceneVersionGatewayImpl(options.versioning, options.projects)
  const factory = new LangChainAgentFactoryImpl(
    new LangChainModelFactory(options.loadSettings, options.fetcher),
    new FilePromptLoader(options.promptRoot)
  )
  const agentImplementation = WebGalSceneAgentImpl
  const graphDependencies = { saver, stateRoot, artifacts }
  /** 模型连接可在启动后配置；装配阶段不创建需要已存设置的智能体。 */
  const workflow = new WebGalSceneGenerationWorkflowImpl(graphDependencies, files, () =>
    factory.create(agentImplementation, {
      model: { override: { requestTimeoutMs: undefined } },
      override: { toolTimeoutMs: undefined }
    })
  )
  const history = new WebGalSceneGenerationHistoryReaderImpl(graphDependencies, files, executions)
  const memory = new SceneGenerationMemoryGatewayImpl(stateRoot, executions)
  const dependencies: SceneGenerationDependencies = {
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
  const generation = new SceneGenerationApplicationServiceImpl(dependencies, coordinator)
  const launch = options.render
    ? new SceneGenerationLaunchServiceImpl(dependencies, options.render, generation, coordinator)
    : undefined
  return {
    generation,
    ...(launch ? { launch } : {}),
    ...(options.render
      ? {
          renderQuery: new SceneGenerationRenderQueryServiceImpl(dependencies, coordinator),
          control: new SceneGenerationControlServiceImpl(dependencies, coordinator, generation),
          candidatePreview: new SceneGenerationCandidatePreviewServiceImpl(
            dependencies,
            options.render,
            coordinator
          )
        }
      : {}),
    status: new SceneGenerationStatusQueryServiceImpl(dependencies, coordinator),
    history: new SceneGenerationHistoryQueryServiceImpl(history, executions),
    candidateEdit: new SceneGenerationCandidateEditServiceImpl(
      dependencies,
      coordinator,
      options.render?.preview
    ),
    memory: new SceneGenerationMemoryServiceImpl(dependencies, coordinator),
    close: async () => {
      await options.render?.preview.close?.()
    },
    ports: { input, executions, workspace, artifacts, versions, workflow, history, memory }
  }
}
