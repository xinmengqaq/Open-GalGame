import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { mkdir, realpath, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'

import { createProjectServices } from '../projects'
import { assertUserDirectory } from '../userDirectory'
import {
  recoverLegacyUserDirectory,
  type DevUserDirectoryRecoveryResult
} from '../devUserDirectoryRecovery'
import { createSceneExport } from '../sceneExport'
import { ManageAppearanceSettings } from '@application/settings/appearance/services/impl/ManageAppearanceSettings'
import { OpenDirectory } from '@application/system-path/services/impl/OpenDirectory'
import { LocalDirectoryOpenGateway } from '@infrastructure/system-path/LocalDirectoryOpenGateway'
import { SystemPathController } from '@interfaces/system-path/ipc/SystemPathController'
import { createScenePreview } from '../scenePreview'
import type { ConnectionSettingsInfo } from '@domain/settings/connections/models/ConnectionSettings'
import type { PreviewRuntimeEventVO } from '@application/scene-preview/vo/PreviewRuntimeVO'
import type {
  SceneGenerationCandidatePreviewEventVO,
  SceneGenerationRenderProgressEventVO
} from '@application/scene-generation/vo/SceneGenerationRenderVO'
import type { ProjectFileDialogGateway } from '@application/projects/ports/ProjectFileDialogGateway'
import type { ProjectLocation } from '@application/projects/models/ProjectLocation'
import type { AjaxResult } from '@common/contracts/AjaxResult'
import { AppException } from '@common/errors/AppException'
import { ErrorCodes } from '@common/errors/ErrorCodes'
import { errorFacts } from '@common/errors/errorFacts'
import {
  diagnosticFactPayload,
  FAILURE_CAUSE_NAME,
  recordedFailureOf
} from '@application/scene-generation/services/impl/SceneGenerationFailureFacts'
import { AiProjectFileSystemImpl } from '@infrastructure/ai/filesystem/AiProjectFileSystemImpl'
import { FileConfigurationGatewayImpl } from '@infrastructure/config/FileConfigurationGatewayImpl'
import { PinoLoggerGatewayImpl } from '@infrastructure/logging/PinoLoggerGatewayImpl'
import { diagnosticReference } from '../sceneGenerationFailureFacts'
import { GitCandidatePreviewGatewayImpl } from '@infrastructure/scene-generation/preview/GitCandidatePreviewGatewayImpl'
import { WebgalRuntimeHostImpl } from '@infrastructure/webgal/runtime/WebgalRuntimeHostImpl'
import type { SecretCipher } from '@infrastructure/security/SecretCipher'
import { AppearanceSettingsGatewayImpl } from '@infrastructure/settings/AppearanceSettingsGatewayImpl'
import { AppearanceSettingsController } from '@interfaces/settings/appearance/ipc/AppearanceSettingsController'
import { ConnectionSettingsController } from '@interfaces/settings/connections/ipc/ConnectionSettingsController'
import { ProjectController } from '@interfaces/ipc/controllers/ProjectController'
import { IpcErrorMapper } from '@interfaces/ipc/errors/IpcErrorMapper'
import { IpcExceptionHandler } from '@interfaces/ipc/errors/IpcExceptionHandler'
import { parseRequest, type IpcRequestAccess } from '@interfaces/ipc/RequestSchema'
import { ProjectFilesController } from '@interfaces/project-files/ipc/ProjectFilesController'
import { ProjectVersioningController } from '@interfaces/project-versioning/ipc/ProjectVersioningController'
import { SceneCanvasController } from '@interfaces/scene-canvas/ipc/SceneCanvasController'
import { SceneExportController } from '@interfaces/scene-export/ipc/SceneExportController'
import { SceneGenerationController } from '@interfaces/scene-generation/ipc/SceneGenerationController'
import { sceneGenerationProgressSchema } from '@interfaces/scene-generation/ipc/SceneGenerationRequestSchema'
import { ScenePreviewController } from '@interfaces/scene-preview/ipc/ScenePreviewController'

type DevCall = (input: unknown, access: IpcRequestAccess) => Promise<AjaxResult<unknown>>

export interface DevFileBackend {
  call(method: string, input: unknown): Promise<AjaxResult<unknown>>
  stageFile(fileName: string, bytes: Uint8Array): Promise<AjaxResult<string>>
  readMedia(input: unknown): Promise<AjaxResult<unknown>>
  watchGenerationProgress(
    input: unknown,
    publish: (event: SceneGenerationRenderProgressEventVO) => void
  ): Promise<{ result: AjaxResult<null>; stop: () => void }>
  subscribeScenePreviewEvents(publish: (event: PreviewRuntimeEventVO) => void): () => void
  subscribeCandidatePreviewEvents(
    publish: (event: SceneGenerationCandidatePreviewEventVO) => void
  ): () => void
  close(): Promise<void>
}

export function openPathWithSystem(absolutePath: string): Promise<string> {
  const command =
    process.platform === 'win32'
      ? { file: 'cmd.exe', args: ['/c', 'start', '', absolutePath] }
      : process.platform === 'darwin'
        ? { file: 'open', args: [absolutePath] }
        : { file: 'xdg-open', args: [absolutePath] }
  return new Promise((resolve) => {
    const child = spawn(command.file, command.args, {
      detached: true,
      stdio: 'ignore',
      windowsHide: true
    })
    child.once('error', () => resolve('系统无法打开该文件'))
    child.once('spawn', () => {
      child.unref()
      resolve('')
    })
  })
}

export async function createDevFileBackend(
  userDirectory: string,
  recovery?: DevUserDirectoryRecoveryResult
): Promise<DevFileBackend> {
  const logger = new PinoLoggerGatewayImpl(
    join(userDirectory, 'logs'),
    new FileConfigurationGatewayImpl(join(userDirectory, 'runtime-config.json')).getSnapshot()
  )
  if (recovery && recovery.recovered > 0) {
    logger.info(
      `恢复旧用户目录登记 ${recovery.recovered} 项${
        recovery.skippedConflicts > 0 ? `，跳过冲突 ${recovery.skippedConflicts} 项` : ''
      }`
    )
  }
  const services = createProjectServices({
    userDirectory,
    dialogs: new NodeProjectFileDialogGateway(),
    logger,
    openPath: openPathWithSystem
  })
  const exceptions = new IpcExceptionHandler(logger, new IpcErrorMapper())
  const candidatePreviewGateway = new GitCandidatePreviewGatewayImpl(
    new AiProjectFileSystemImpl(userDirectory),
    join(userDirectory, 'ai'),
    Date.now,
    undefined,
    undefined,
    { logger }
  )
  const candidateEventSinks = new Set<(event: SceneGenerationCandidatePreviewEventVO) => void>()
  const stopCandidateEvents = candidatePreviewGateway.subscribeCandidatePreviewEvents((event) => {
    for (const sink of candidateEventSinks) sink(event)
  })
  const projects = new ProjectController(services.projects, exceptions)
  const files = new ProjectFilesController(services.projectFiles, exceptions, {
    chooseProjectFiles: () => Promise.resolve(null)
  })
  const canvas = new SceneCanvasController(services.sceneCanvas, exceptions)
  const versioning = new ProjectVersioningController(services.versioning, exceptions)
  const config = new FileConfigurationGatewayImpl(
    join(userDirectory, 'runtime-config.json')
  ).getSnapshot()
  let generationController: SceneGenerationController | undefined
  let generationClose: (() => Promise<void>) | undefined
  let connectionsController: ConnectionSettingsController | undefined
  let appearanceController: AppearanceSettingsController | undefined
  let loadConnectionSettings: (() => Promise<ConnectionSettingsInfo | null>) | undefined
  let previewController: ScenePreviewController | undefined
  let exportController: SceneExportController | undefined
  let systemPathController: SystemPathController | undefined
  let previewHost: { dispose(): Promise<void> } | undefined
  const previewSubscriptionStops: Array<() => void> = []
  const previewEventSinks = new Set<(event: PreviewRuntimeEventVO) => void>()

  async function ensureConnections(): Promise<ConnectionSettingsController> {
    if (connectionsController) return connectionsController
    const { ManageConnectionSettings } =
      await import('@application/settings/connections/services/impl/ManageConnectionSettings')
    const { EncryptedConnectionSettingsGatewayImpl } =
      await import('@infrastructure/connections/EncryptedConnectionSettingsGatewayImpl')
    // 连接设置在首次打开时才装配；Pi 适配模块随这条懒加载链进入，不拖慢启动。
    const { PiModelConnectionGatewayImpl } =
      await import('@infrastructure/ai/pi/PiModelConnectionGatewayImpl')
    const { PiModelFactory } = await import('@infrastructure/ai/pi/PiModelFactory')
    const gateway = new EncryptedConnectionSettingsGatewayImpl(
      userDirectory,
      new BrowserDevSecretCipher(browserCipherKey(userDirectory)),
      { models: 'browser-models.json', credentials: 'browser-credentials.json' }
    )
    loadConnectionSettings = () => gateway.loadSettings()
    connectionsController = new ConnectionSettingsController(
      new ManageConnectionSettings({
        settings: gateway,
        model: new PiModelConnectionGatewayImpl(
          new PiModelFactory(() => gateway.loadSettings()),
          config.requestTimeoutMs
        )
      }),
      exceptions
    )
    return connectionsController
  }

  function ensureAppearance(): AppearanceSettingsController {
    if (appearanceController) return appearanceController
    appearanceController = new AppearanceSettingsController(
      new ManageAppearanceSettings({
        settings: new AppearanceSettingsGatewayImpl(userDirectory),
        logger
      }),
      exceptions
    )
    return appearanceController
  }

  async function ensureGeneration(): Promise<SceneGenerationController> {
    if (generationController) return generationController
    await ensureConnections()
    const { createSceneGeneration } = await import('../sceneGeneration')
    const { RegisteredSceneProductionContext } =
      await import('@infrastructure/scene-generation/inputs/RegisteredSceneProductionContext')
    const resourceRoot = [
      join(process.cwd(), 'resources/ai'),
      join(process.cwd(), 'opengalgame/resources/ai')
    ].find((path) => existsSync(join(path, 'prompts')))
    if (!resourceRoot || !loadConnectionSettings) {
      throw new AppException({ code: ErrorCodes.invalidConfig, msg: '生成提示词目录不存在' })
    }
    const created = await createSceneGeneration({
      userStateRoot: userDirectory,
      promptRoot: join(resourceRoot, 'prompts'),
      loadSettings: loadConnectionSettings,
      dispatch: (job, identity) => {
        void job().catch((error: unknown) => {
          const facts = errorFacts(error)
          const category = error instanceof AppException ? error.diagnosticCategory : undefined
          const causeNames = facts.causeNames.filter((name) => FAILURE_CAUSE_NAME.test(name))
          const payload = diagnosticFactPayload({ ...facts, causeNames }, category)
          const diagnosticRef = payload ? diagnosticReference(payload) : undefined
          const recorded = recordedFailureOf(error)
          logger.error('场景生成后台任务失败', {
            operationId: identity.operationId,
            projectId: identity.projectId,
            errorCode: error instanceof AppException ? error.code : ErrorCodes.internalError,
            ...(facts.errorName ? { errorName: facts.errorName } : {}),
            ...(causeNames.length > 0 ? { causeNames: causeNames.join(',') } : {}),
            ...(facts.causeCodes.length > 0 ? { causeCodes: facts.causeCodes.join(',') } : {}),
            ...(facts.statuses.length > 0 ? { statuses: facts.statuses.join(',') } : {}),
            ...(diagnosticRef ? { diagnosticRef } : {}),
            ...(recorded?.diagnosticRef && recorded.diagnosticRef !== diagnosticRef
              ? { recordedDiagnosticRef: recorded.diagnosticRef }
              : {}),
            ...(category ? { category } : {}),
            ...(recorded?.category && recorded.category !== category
              ? { recordedCategory: recorded.category }
              : {})
          })
        })
      },
      publishProgress: () => undefined,
      versioning: services.versioning,
      projects: services.projects,
      render: {
        canvasVersions: services.canvasVersions,
        saveArrangement: (request) => services.sceneCanvas.saveSceneCanvasArrangement(request),
        readCurrentArrangement: (request) =>
          services.sceneCanvas.readSceneCanvasArrangement(request),
        production: new RegisteredSceneProductionContext(userDirectory),
        preview: candidatePreviewGateway
      }
    })
    if (!created.launch || !created.renderQuery || !created.control || !created.candidatePreview) {
      throw new AppException({ code: ErrorCodes.invalidConfig, msg: '场景生成应用服务未装配' })
    }
    generationClose = () => created.close()
    generationController = new SceneGenerationController(
      {
        launch: created.launch,
        renderQuery: created.renderQuery,
        control: created.control,
        history: created.history,
        preview: created.candidatePreview,
        generation: created.generation
      },
      exceptions
    )
    return generationController
  }

  async function ensurePreview(): Promise<ScenePreviewController> {
    if (previewController) return previewController
    const requireFromDevBackend = createRequire(import.meta.url)
    const engineRoot = dirname(requireFromDevBackend.resolve('webgal-engine/package.json'))
    const host = new WebgalRuntimeHostImpl({
      engineRoot,
      engineExtension: { autoStart: true }
    })
    const previewServices = createScenePreview({
      userDirectory,
      versioning: services.versioning,
      sessionLookup: candidatePreviewGateway,
      host
    })
    previewHost = host
    previewController = new ScenePreviewController(
      previewServices.currentScenePreview,
      previewServices.candidatePreview,
      exceptions,
      candidatePreviewGateway
    )
    const exportServices = createSceneExport({
      userDirectory,
      logger,
      versioning: services.versioning,
      sources: previewServices.currentScene.sources,
      chooseDirectory: pickDirectoryWithSystem
    })
    exportController = new SceneExportController(
      exportServices.exportSavedScene,
      exportServices.latestSavedSceneVersion,
      exportServices.chooseDestination,
      exceptions
    )
    return previewController
  }

  async function ensureExport(): Promise<SceneExportController> {
    await ensurePreview()
    if (!exportController) {
      throw new AppException({ code: ErrorCodes.internalError, msg: '场景导出未装配' })
    }
    return exportController
  }

  function ensureSystemPath(): SystemPathController {
    if (!systemPathController) {
      systemPathController = new SystemPathController(
        new OpenDirectory({
          directories: new LocalDirectoryOpenGateway(openPathWithSystem)
        }),
        exceptions
      )
    }
    return systemPathController
  }

  const methods: Record<string, DevCall> = {
    chooseSaveLocation: (input, access) => projects.chooseSaveLocation(input, access),
    clearSaveLocation: (input, access) => projects.clearSaveLocation(input, access),
    createProject: (input, access) => projects.createProject(input, access),
    importProject: (input, access) => projects.importProject(input, access),
    listProjects: (input, access) => projects.listProjects(input, access),
    openProject: (input, access) => projects.openProject(input, access),
    renameProject: (input, access) => projects.renameProject(input, access),
    unregisterProject: (input, access) => projects.unregisterProject(input, access),
    ensureProjectWorkspace: (input, access) => projects.ensureProjectWorkspace(input, access),
    inspectProjectWorkspace: (input, access) => projects.inspectProjectWorkspace(input, access),
    inspectProjectFiles: (input, access) => files.inspectProjectFiles(input, access),
    listProjectInputSources: (input, access) => files.listProjectInputSources(input, access),
    readProjectInputSources: (input, access) => files.readProjectInputSources(input, access),
    readProjectMedia: (input, access) => files.readProjectMedia(input, access),
    importProjectFiles: (input, access) => files.importProjectFiles(input, access),
    openProjectFile: (input, access) => files.openProjectFile(input, access),
    renameProjectFile: (input, access) => files.renameProjectFile(input, access),
    deleteProjectFile: (input, access) => files.deleteProjectFile(input, access),
    createProjectTextFile: (input, access) => files.createProjectTextFile(input, access),
    updateProjectTextFileBody: (input, access) => files.updateProjectTextFileBody(input, access),
    createProjectFolder: (input, access) => files.createProjectFolder(input, access),
    copyProjectFile: (input, access) => files.copyProjectFile(input, access),
    moveProjectFile: (input, access) => files.moveProjectFile(input, access),
    copyProjectFolder: (input, access) => files.copyProjectFolder(input, access),
    renameProjectFolder: (input, access) => files.renameProjectFolder(input, access),
    readProjectFolderDeletionPlan: (input, access) =>
      files.readProjectFolderDeletionPlan(input, access),
    deleteProjectFolder: (input, access) => files.deleteProjectFolder(input, access),
    readProjectFileOperation: (input, access) => files.readProjectFileOperation(input, access),
    recoverProjectFileOperations: (input, access) =>
      files.recoverProjectFileOperations(input, access),
    readSceneCanvasArrangement: (input, access) => canvas.readSceneCanvasArrangement(input, access),
    createSceneCanvasSourceCard: (input, access) => canvas.createSourceCard(input, access),
    createSceneCanvasPromptCard: (input, access) => canvas.createPromptCard(input, access),
    createSceneCanvasFieldCard: (input, access) => canvas.createFieldCard(input, access),
    editSceneCanvasCard: (input, access) => canvas.editCard(input, access),
    editSceneCanvasPromptBody: (input, access) => canvas.editPromptBody(input, access),
    bindSceneCanvasFieldCardPreset: (input, access) => canvas.bindFieldCardPreset(input, access),
    editSceneCanvasMediaRole: (input, access) => canvas.editMediaRole(input, access),
    copySceneCanvasCard: (input, access) => canvas.copyCard(input, access),
    deleteSceneCanvasCard: (input, access) => canvas.deleteCard(input, access),
    connectSceneCanvasCards: (input, access) => canvas.connectCards(input, access),
    disconnectSceneCanvasCards: (input, access) => canvas.disconnectCards(input, access),
    editSceneCanvasRelationName: (input, access) => canvas.editRelationName(input, access),
    attachSceneCanvasRelationRecord: (input, access) => canvas.attachRelationRecord(input, access),
    detachSceneCanvasRelationRecord: (input, access) => canvas.detachRelationRecord(input, access),
    saveSceneCanvasArrangement: (input, access) => canvas.saveSceneCanvasArrangement(input, access),
    listVersionHistory: (input, access) => versioning.listHistory(input, access),
    undoVersionHistoryEntry: (input, access) => versioning.undoHistoryEntry(input, access),
    clearVersionHistory: (input, access) => versioning.clearHistory(input, access),
    readScenePreviewAvailability: async (input, access) =>
      (await ensurePreview()).readAvailability(input, access),
    openScenePreview: async (input, access) => (await ensurePreview()).open(input, access),
    preparePreviewStage: async (input, access) => (await ensurePreview()).prepare(input, access),
    previewDialogueDraft: async (input, access) =>
      (await ensurePreview()).previewDraft(input, access),
    saveDialogueChanges: async (input, access) => (await ensurePreview()).save(input, access),
    readDialogueSaveSettlement: async (input, access) =>
      (await ensurePreview()).readSettlement(input, access),
    selectPreviewDialogue: async (input, access) =>
      (await ensurePreview()).selectDialogue(input, access),
    playPreviousDialogue: async (input, access) =>
      (await ensurePreview()).previousDialogue(input, access),
    playNextDialogue: async (input, access) => (await ensurePreview()).nextDialogue(input, access),
    closeScenePreview: async (input, access) => {
      const controller = await ensurePreview()
      const result = await controller.close(input, access)
      if (result.code === ErrorCodes.success) {
        for (const stop of previewSubscriptionStops.splice(0)) stop()
      }
      return result
    },
    subscribeScenePreviewRuntime: async (input, access) => {
      const controller = await ensurePreview()
      const subscribed = await controller.subscribe(input, access, (event) => {
        for (const sink of previewEventSinks) sink(event)
      })
      if (subscribed.accepted.code === ErrorCodes.success && subscribed.unsubscribe) {
        previewSubscriptionStops.push(subscribed.unsubscribe)
      }
      return subscribed.accepted
    },
    readCandidatePreview: async (input, access) =>
      (await ensurePreview()).readCandidate(input, access),
    readCandidatePreviewEvent: async (input, access) =>
      (await ensurePreview()).readCandidateEvent(input, access),
    exportSavedScene: async (input, access) =>
      (await ensureExport()).exportSavedScene(input, access),
    readLatestSavedSceneVersion: async (input, access) =>
      (await ensureExport()).readLatestSavedSceneVersion(input, access),
    chooseSceneExportDirectory: async (input, access) =>
      (await ensureExport()).chooseSceneExportDirectory(input, access),
    openDirectory: async (input, access) => ensureSystemPath().openDirectory(input, access),
    getSettingsSummary: async (input, access) =>
      (await ensureConnections()).getSettingsSummary(input, access),
    testConnection: async (input, access) =>
      (await ensureConnections()).testConnection(input, access),
    saveSettings: async (input, access) => (await ensureConnections()).saveSettings(input, access),
    listModels: async (input, access) => (await ensureConnections()).listModels(input, access),
    readAppearance: (input, access) => ensureAppearance().readAppearance(input, access),
    saveAppearance: (input, access) => ensureAppearance().saveAppearance(input, access),
    startSceneGeneration: async (input, access) => (await ensureGeneration()).start(input, access),
    retrySceneGenerationRepair: async (input, access) =>
      (await ensureGeneration()).retryRepair(input, access),
    getSceneGenerationStatus: async (input, access) =>
      (await ensureGeneration()).status(input, access),
    getLatestSceneGeneration: async (input, access) =>
      (await ensureGeneration()).latest(input, access),
    replySceneGeneration: async (input, access) => (await ensureGeneration()).reply(input, access),
    pauseSceneGeneration: async (input, access) => (await ensureGeneration()).pause(input, access),
    resumeSceneGeneration: async (input, access) =>
      (await ensureGeneration()).resume(input, access),
    cancelSceneGeneration: async (input, access) =>
      (await ensureGeneration()).cancel(input, access),
    listSceneGenerationHistory: async (input, access) =>
      (await ensureGeneration()).listHistory(input, access),
    readSceneGenerationCheckpoint: async (input, access) =>
      (await ensureGeneration()).readCheckpoint(input, access),
    forkSceneGeneration: async (input, access) => (await ensureGeneration()).fork(input, access),
    openSceneGenerationPreview: async (input, access) =>
      (await ensureGeneration()).openPreview(input, access),
    closeSceneGenerationPreview: async (input, access) =>
      (await ensureGeneration()).closePreview(input, access),
    subscribeSceneGenerationProgress: async (input, access) =>
      (await ensureGeneration()).subscribe(input, access)
  }

  return {
    call(method, input) {
      const handler = methods[method]
      if (!handler) {
        return Promise.resolve({ code: ErrorCodes.invalidRequest, msg: '请求参数格式不正确' })
      }
      return handler(input, { trusted: true, requestId: randomUUID() })
    },
    readMedia(input) {
      return methods.readProjectMedia!(input, { trusted: true, requestId: randomUUID() })
    },
    async stageFile(fileName, bytes) {
      const name = safeUploadName(fileName)
      if (!name) return { code: ErrorCodes.invalidRequest, msg: '文件名无效' }
      const directory = join(tmpdir(), 'opengalgame-browser-dev', randomUUID())
      await mkdir(directory, { recursive: true })
      const path = join(directory, name)
      await writeFile(path, bytes)
      return { code: ErrorCodes.success, msg: '已暂存导入文件', data: path }
    },
    async watchGenerationProgress(input, publish) {
      const access = { trusted: true, requestId: randomUUID() }
      const generation = await ensureGeneration()
      const result = await generation.subscribe(input, access)
      if (result.code !== ErrorCodes.success) return { result, stop: () => undefined }
      const request = parseRequest(sceneGenerationProgressSchema, input, access)
      const stop = generation.watchProgress(request, (event) => {
        if (
          event.operationId !== request.operationId ||
          event.threadId !== request.threadId ||
          event.branchId !== request.branchId
        ) {
          return
        }
        publish(event)
      })
      return { result, stop }
    },
    subscribeScenePreviewEvents(publish) {
      previewEventSinks.add(publish)
      return () => {
        previewEventSinks.delete(publish)
      }
    },
    subscribeCandidatePreviewEvents(publish) {
      candidateEventSinks.add(publish)
      return () => {
        candidateEventSinks.delete(publish)
      }
    },
    async close() {
      for (const stop of previewSubscriptionStops.splice(0)) stop()
      previewEventSinks.clear()
      candidateEventSinks.clear()
      stopCandidateEvents()
      if (previewHost) await previewHost.dispose()
      if (generationClose) await generationClose()
      else await candidatePreviewGateway.close()
      await services.close()
      await logger.close()
    }
  }
}

let singleton: Promise<DevFileBackend> | undefined

export function loadDevFileBackend(): Promise<DevFileBackend> {
  const directory = assertUserDirectory(
    process.env.OPENGALGAME_DEV_USER_DIRECTORY || join(homedir(), '.opengalgame')
  )
  singleton ??= recoverLegacyUserDirectory(directory).then((recovery) =>
    createDevFileBackend(directory, recovery)
  )
  return singleton
}

class NodeProjectFileDialogGateway implements ProjectFileDialogGateway {
  private pendingCreate: string | null = null

  selectDirectory(): Promise<ProjectLocation | null> {
    return this.pickDirectory()
  }

  async chooseSaveLocation(): Promise<ProjectLocation | null> {
    const preset = process.env.OPENGALGAME_DEV_SAVE_LOCATION?.trim()
    if (preset) {
      const directory = await realpath(preset)
      this.pendingCreate = directory
      return { directory }
    }
    const location = await this.pickDirectory()
    if (location) this.pendingCreate = location.directory
    return location
  }

  takeSaveLocation(): Promise<ProjectLocation | null> {
    if (this.pendingCreate) return Promise.resolve({ directory: this.pendingCreate })
    return this.pickDirectory()
  }

  clearSaveLocation(): void {
    this.pendingCreate = null
  }

  private async pickDirectory(): Promise<ProjectLocation | null> {
    const selected = await pickDirectoryWithSystem()
    if (!selected) return null
    return { directory: await realpath(selected) }
  }
}

function pickDirectoryWithSystem(): Promise<string | null> {
  const command =
    process.platform === 'win32'
      ? {
          file: 'powershell.exe',
          args: [
            '-STA',
            '-NoProfile',
            '-Command',
            [
              'Add-Type -AssemblyName System.Windows.Forms',
              '$dialog = New-Object System.Windows.Forms.FolderBrowserDialog',
              "$dialog.Description = '选择目录'",
              '$dialog.ShowNewFolderButton = $true',
              '$result = $dialog.ShowDialog()',
              'if ($result -eq [System.Windows.Forms.DialogResult]::OK) { Write-Output $dialog.SelectedPath }'
            ].join('; ')
          ]
        }
      : process.platform === 'darwin'
        ? {
            file: 'osascript',
            args: ['-e', 'POSIX path of (choose folder)']
          }
        : { file: 'zenity', args: ['--file-selection', '--directory'] }
  return new Promise((resolve, reject) => {
    const child = spawn(command.file, command.args, { windowsHide: false })
    let output = ''
    child.stdout.on('data', (chunk: Buffer) => {
      output += chunk.toString('utf8')
    })
    child.once('error', () => {
      reject(new AppException({ code: ErrorCodes.internalError, msg: '系统目录选择失败' }))
    })
    child.once('close', (code) => {
      const directory = output.trim()
      if (directory) {
        resolve(directory)
        return
      }
      if (code === 0 || process.platform === 'win32') {
        resolve(null)
        return
      }
      reject(new AppException({ code: ErrorCodes.internalError, msg: '系统目录选择失败' }))
    })
  })
}

class BrowserDevSecretCipher implements SecretCipher {
  constructor(private readonly key: Buffer) {}

  encrypt(value: string): Buffer {
    const iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', this.key, iv)
    const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
    return Buffer.concat([Buffer.from('OG1'), iv, cipher.getAuthTag(), encrypted])
  }

  decrypt(value: Buffer): string {
    const iv = value.subarray(3, 15)
    const tag = value.subarray(15, 31)
    const encrypted = value.subarray(31)
    const decipher = createDecipheriv('aes-256-gcm', this.key, iv)
    decipher.setAuthTag(tag)
    return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8')
  }
}

function browserCipherKey(userDirectory: string): Buffer {
  const path = join(userDirectory, 'browser-dev-key')
  if (existsSync(path)) {
    const existing = readFileSync(path)
    if (existing.length === 32) return existing
  }
  const key = randomBytes(32)
  writeFileSync(path, key, { mode: 0o600 })
  return key
}

function safeUploadName(fileName: string): string | null {
  const name = basename(fileName)
  if (!name || name === '.' || name === '..' || name !== fileName.trim()) return null
  if (name.includes('\\') || name.includes('/') || name.includes('\u0000')) return null
  return name
}
