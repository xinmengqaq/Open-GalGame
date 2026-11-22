import { randomUUID } from 'node:crypto'
import { isAbsolute, join } from 'node:path'
import { RunSceneGeneration } from '@application/scene-generation/services/impl/RunSceneGeneration'
import { PreviewSceneGenerationCandidate } from '@application/scene-generation/services/impl/PreviewSceneGenerationCandidate'
import { ControlSceneGeneration } from '@application/scene-generation/services/impl/ControlSceneGeneration'
import { LaunchSceneGeneration } from '@application/scene-generation/services/impl/LaunchSceneGeneration'
import { QuerySceneGenerationRender } from '@application/scene-generation/services/impl/QuerySceneGenerationRender'
import type { SceneGenerationRenderDependencies } from '@application/scene-generation/services/impl/SceneGenerationRenderDependencies'
import { QuerySceneGenerationStatus } from '@application/scene-generation/services/impl/QuerySceneGenerationStatus'
import { RecoverCancelledSceneGeneration } from '@application/scene-generation/services/impl/RecoverCancelledSceneGeneration'
import { QuerySceneGenerationHistory } from '@application/scene-generation/services/impl/QuerySceneGenerationHistory'
import { EditSceneGenerationCandidate } from '@application/scene-generation/services/impl/EditSceneGenerationCandidate'
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
import { PiSceneGenerationWorkflow } from '@infrastructure/scene-generation/pi/PiSceneGenerationWorkflow'
import { ConfirmedWriteRecovery } from '@infrastructure/scene-generation/execution/ConfirmedWriteRecovery'
import { FileForkSourceEvidenceStore } from '@infrastructure/scene-generation/execution/FileForkSourceEvidenceStore'
import type { SceneGenerationWriteRecovery } from '@application/scene-generation/ports/SceneGenerationWriteRecovery'
import { WebGalSceneGenerationHistoryReaderImpl } from '@infrastructure/scene-generation/history/WebGalSceneGenerationHistoryReaderImpl'
import { SceneGenerationMemoryGatewayImpl } from '@infrastructure/scene-generation/memory/SceneGenerationMemoryGatewayImpl'
import { AiProjectFileSystemImpl } from '@infrastructure/ai/filesystem/AiProjectFileSystemImpl'
import {
  assembleAgentExecutionProfile,
  type AgentExecutionOverride
} from '@infrastructure/ai/config/agentExecutionConfig'
import { PiAgentFactory } from '@infrastructure/ai/pi/PiAgentFactory'
import { PiModelFactory } from '@infrastructure/ai/pi/PiModelFactory'
import { FilePromptLoader } from '@infrastructure/ai/prompts/FilePromptLoader'
import { FileSkillLoader } from '@infrastructure/ai/skills/FileSkillLoader'
import type { ProjectVersioningApplicationService } from '@application/project-versioning/services/ProjectVersioningApplicationService'
import type { ProjectApplicationService } from '@application/projects/services/ProjectApplicationService'
import { ReadOnlyGenerationCheckpointStore } from '@infrastructure/workflow/checkpoints/ReadOnlyCheckpointStore'
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
  /** 受信技能根；省略时从提示词资源根的相邻 skills 目录读取。 */
  skillsRoot?: string
  registrations?: readonly SceneGenerationRegistration[]
  loadSettings: () => Promise<ConnectionSettingsInfo | null>
  fetcher?: typeof fetch
  /**
   * 内部执行预算覆盖；由可信装配或测试夹具提供，不进入请求 DTO、IPC 或操作指纹。
   * 省略时使用 AI 执行配置默认值。
   */
  execution?: AgentExecutionOverride
  dispatch: (job: () => Promise<void>, identity: SceneGenerationDispatchIdentity) => void
  publishProgress: (event: SceneGenerationProgressVO) => void
  versioning: ProjectVersioningApplicationService
  projects: Pick<ProjectApplicationService, 'ensureProjectWorkspace'>
  render?: SceneGenerationRenderDependencies
}

export type SceneGenerationServices = {
  generation: RunSceneGeneration
  launch?: LaunchSceneGeneration
  renderQuery: QuerySceneGenerationRender
  control: ControlSceneGeneration
  candidatePreview?: PreviewSceneGenerationCandidate
  status: QuerySceneGenerationStatus
  history: QuerySceneGenerationHistory
  candidateEdit: EditSceneGenerationCandidate
  memory: ClearSceneGenerationMemory
  /** 工程打开时结算上次退出遗留的已受理取消；不启动模型或新提交。 */
  recovery: RecoverCancelledSceneGeneration
  close: () => Promise<void>
  ports: {
    input: SceneInputGatewayImpl
    executions: FileSceneGenerationExecutionRepositoryImpl
    workspace: WebGalSceneGenerationWorkspaceGatewayImpl
    artifacts: WebGalSceneArtifactGatewayImpl
    versions: SceneVersionGatewayImpl
    writeRecovery: SceneGenerationWriteRecovery
    workflow: PiSceneGenerationWorkflow
    history: WebGalSceneGenerationHistoryReaderImpl
    memory: SceneGenerationMemoryGatewayImpl
  }
}

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
  const executionProfile = assembleAgentExecutionProfile(
    options.execution === undefined ? {} : { override: options.execution }
  )
  const files = new AiProjectFileSystemImpl(options.userStateRoot)
  const checkpointStore = new ReadOnlyGenerationCheckpointStore(stateRoot)
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
  const domain = new SceneGenerationDomainServiceImpl()
  const artifacts = new WebGalSceneArtifactGatewayImpl(
    files,
    new SceneSourceReaderGatewayImpl(),
    new SceneScriptParserGatewayImpl(),
    new SceneAssetReferenceGatewayImpl(),
    domain
  )
  const versions = new SceneVersionGatewayImpl(options.versioning, options.projects)
  const history = new WebGalSceneGenerationHistoryReaderImpl(
    stateRoot,
    checkpointStore,
    files,
    executions
  )
  // 建分叉时从权威检查点与不可变修订捕获来源证据；重开只核对这份证据。
  const forkSourceEvidence = new FileForkSourceEvidenceStore(stateRoot, files, (request) =>
    history.readCheckpoint(request)
  )
  /** Pi 执行器按操作读取当前连接设置；密钥只进入本次模型运行时闭包。 */
  const agentFactory = new PiAgentFactory(new PiModelFactory(options.loadSettings, options.fetcher))
  const workflow = new PiSceneGenerationWorkflow({
    artifacts,
    versions,
    domain,
    prompts: new FilePromptLoader(options.promptRoot),
    skills: new FileSkillLoader(options.skillsRoot ?? join(options.promptRoot, '..', 'skills')),
    stateRoot,
    ...(options.execution === undefined ? {} : { executionOverride: options.execution }),
    createAgent: () => agentFactory.create(),
    nextId: randomUUID,
    now: Date.now,
    // 分叉重开核对创建时捕获的来源证据；不再读取来源操作当前检查点。
    forkSourceEvidence
  })
  const memory = new SceneGenerationMemoryGatewayImpl(stateRoot, executions)
  // 分叉父修订恢复按创建时捕获的来源证据与不可变 Git 归属独立证明。
  const writeRecovery = new ConfirmedWriteRecovery(
    stateRoot,
    files,
    artifacts,
    async (execution, revisionId) =>
      (await forkSourceEvidence.verify(execution, revisionId)).ok
  )
  const dependencies: SceneGenerationDependencies = {
    domain,
    input,
    executions,
    workspace,
    artifacts,
    versions,
    writeRecovery,
    forkSourceEvidence,
    workflow,
    history,
    memory,
    workflowControl: workflow,
    activeLimitMs: executionProfile.activeLimitMs,
    candidatePreview: options.render?.preview,
    nextId: randomUUID,
    now: Date.now,
    dispatch: options.dispatch,
    publishProgress: options.publishProgress
  }
  const coordinator = new SceneGenerationCoordinator(dependencies)
  const generation = new RunSceneGeneration(dependencies, coordinator)
  const recovery = new RecoverCancelledSceneGeneration({ deps: dependencies, coordinator })
  const launch = options.render
    ? new LaunchSceneGeneration(dependencies, options.render, generation, coordinator)
    : undefined
  return {
    generation,
    ...(launch ? { launch } : {}),
    // 控制动作不依赖渲染端口；装配后测试和后台入口都能直接请求安全暂停与显式继续。
    control: new ControlSceneGeneration(dependencies, coordinator, generation),
    // 状态、历史发现和进度查询只读持久事实，不需要候选预览运行时。
    renderQuery: new QuerySceneGenerationRender(dependencies, coordinator),
    ...(options.render
      ? {
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
    recovery,
    close: async () => {
      await options.render?.preview.close?.()
    },
    ports: {
      input,
      executions,
      workspace,
      artifacts,
      versions,
      writeRecovery,
      workflow,
      history,
      memory
    }
  }
}
