import { createProjectFixtureStore, readFixtureMode } from './projectFixtures'
import { createSceneGenerationFixture } from './sceneGenerationFixture'
import { createVersionHistoryFixture } from './versionHistoryFixture'
import {
  fixtureImportProjectFiles,
  fixtureListSources,
  fixturePathForDroppedFile
} from './workbenchCatalogFixture'
import { fixtureInspect, fixtureReadArrangement, fixtureReadSources } from './workbenchFixtures'
import type { AppearanceSettings } from '@domain/settings/appearance/models/AppearanceSettings'
import type { AppearanceSettingsGateway } from '@application/settings/appearance/ports/AppearanceSettingsGateway'
import { ManageAppearanceSettings } from '@application/settings/appearance/services/impl/ManageAppearanceSettings'
import type { AppearanceSettingsVO } from '@application/settings/appearance/vo/AppearanceSettingsVO'
import type {
  ConnectionSettingsDTO,
  ListModelsDTO
} from '@application/settings/connections/dto/ConnectionSettingsDTO'
import type {
  ConnectionSettingsVO,
  ConnectionTestVO,
  ModelListVO
} from '@application/settings/connections/vo/ConnectionSettingsVO'
import type {
  CreateProjectDTO,
  ImportProjectDTO,
  ListProjectsDTO,
  OpenProjectDTO,
  RenameProjectDTO,
  UnregisterProjectDTO
} from '@application/projects/dto/ProjectDTO'
import type { EnsureProjectWorkspaceDTO } from '@application/projects/dto/ProjectWorkspaceDTO'
import type {
  ChooseProjectFilesDTO,
  ReadProjectMediaDTO
} from '@application/project-files/dto/ProjectFilesDTO'
import type { ProjectFileAssetKind } from '@application/project-files/vo/ProjectInputSourceVO'
import type { ProjectMediaVO } from '@application/project-files/vo/ProjectMediaVO'
import type {
  ProjectWorkspaceInspectionVO,
  ProjectWorkspaceVO
} from '@application/projects/vo/ProjectWorkspaceVO'
import type {
  ClearVersionHistoryDTO,
  ListVersionHistoryDTO,
  UndoVersionHistoryDTO
} from '@application/project-versioning/dto/ProjectVersioningDTO'
import type {
  ProjectListEntryVO,
  ProjectProgressVO,
  ProjectOperationVO,
  ProjectSaveLocationVO
} from '@application/projects/vo/ProjectVO'
import type { VersionHistoryPageVO } from '@application/project-versioning/vo/VersionHistoryVO'
import type { SceneGenerationRenderProgressEventVO } from '@application/scene-generation/vo/SceneGenerationRenderVO'
import type { AjaxResult } from '@common/contracts/AjaxResult'
import { ErrorCodes } from '@common/errors/ErrorCodes'
import type { LoggerGateway } from '@common/logging/LoggerGateway'
import { mediaExtensionsForCategories } from '@common/media/mediaFileName'
import type { DesktopBridge } from '@interfaces/client/DesktopBridge'
import { IpcErrorMapper } from '@interfaces/ipc/errors/IpcErrorMapper'
import { IpcExceptionHandler } from '@interfaces/ipc/errors/IpcExceptionHandler'
import type { IpcRequestAccess } from '@interfaces/ipc/RequestSchema'
import { AppearanceSettingsController } from '@interfaces/settings/appearance/ipc/AppearanceSettingsController'

function fileOperationUnavailable(): AjaxResult<never> {
  return { code: ErrorCodes.forbidden, msg: '当前环境不能操作工程文件' }
}

function devBackendUnavailable(): AjaxResult<never> {
  return { code: ErrorCodes.communicationFailed, msg: '开发文件后端不可用' }
}

function usesRealProjectFiles(search: URLSearchParams): boolean {
  if (import.meta.env.VITE_OPENGALGAME_BROWSER_FILES !== 'real') return false
  const projects = search.get('projects')
  if (projects === 'empty' || projects === 'fail') return false
  const workbench = search.get('workbench')
  return workbench !== 'empty' && workbench !== 'fail' && workbench !== 'damaged'
}

function callDev<T>(method: string, input: unknown): Promise<AjaxResult<T>> {
  return fetch('/__opengalgame/dev/call', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ method, input })
  })
    .then(async (response) => {
      if (!response.ok) return devBackendUnavailable()
      return (await response.json()) as AjaxResult<T>
    })
    .catch(() => devBackendUnavailable())
}

function readDevMedia(request: ReadProjectMediaDTO): Promise<AjaxResult<ProjectMediaVO>> {
  const params = new URLSearchParams({ projectId: request.projectId, sourceId: request.sourceId })
  return fetch(`/__opengalgame/dev/media?${params}`)
    .then(async (response) => {
      if (response.status === 403 || response.status === 405) return devBackendUnavailable()
      const contentType = response.headers.get('content-type') ?? ''
      if (contentType.startsWith('application/json')) {
        return (await response.json()) as AjaxResult<ProjectMediaVO>
      }
      if (!response.ok) return devBackendUnavailable()
      const bytes = new Uint8Array(await response.arrayBuffer())
      const encodedName = response.headers.get('x-file-name') ?? ''
      let fileName = 'media'
      try {
        fileName = encodedName ? decodeURIComponent(encodedName) : fileName
      } catch {
        fileName = 'media'
      }
      const contentKind = response.headers.get('x-content-kind')
      if (contentKind !== 'image' && contentKind !== 'audio' && contentKind !== 'video') {
        return devBackendUnavailable()
      }
      const media: ProjectMediaVO = {
        sourceId: request.sourceId,
        contentKind,
        fileName,
        mediaType: contentType,
        bytes
      }
      return { code: ErrorCodes.success, msg: '媒体读取完成', data: media }
    })
    .catch(() => devBackendUnavailable())
}

function stageDevFile(file: File): Promise<AjaxResult<string>> {
  return fetch('/__opengalgame/dev/stage', {
    method: 'POST',
    headers: {
      'content-type': 'application/octet-stream',
      'x-file-name': encodeURIComponent(file.name)
    },
    body: file
  })
    .then(async (response) => {
      if (!response.ok) return devBackendUnavailable()
      return (await response.json()) as AjaxResult<string>
    })
    .catch(() => devBackendUnavailable())
}

function sceneCanvasUnavailable(): AjaxResult<never> {
  return { code: ErrorCodes.forbidden, msg: '当前环境不能操作场景画布' }
}

function sceneGenerationUnavailable(): AjaxResult<never> {
  return { code: ErrorCodes.forbidden, msg: '当前环境不支持场景生成' }
}

function versionHistoryUnavailable(): AjaxResult<never> {
  return { code: ErrorCodes.communicationFailed, msg: '当前环境不能读取作品历史' }
}

function scenePreviewUnavailable(): AjaxResult<never> {
  return { code: ErrorCodes.forbidden, msg: '当前环境不支持场景预览' }
}

function sceneExportUnavailable(): AjaxResult<never> {
  return { code: ErrorCodes.forbidden, msg: '当前环境不支持场景导出' }
}

function latestSavedSceneVersionUnavailable(): AjaxResult<never> {
  return { code: ErrorCodes.forbidden, msg: '当前环境不支持读取场景保存版本' }
}

function chooseExportDirectoryUnavailable(): AjaxResult<never> {
  return { code: ErrorCodes.forbidden, msg: '当前环境不能选择导出位置' }
}

function systemPathUnavailable(): AjaxResult<never> {
  return { code: ErrorCodes.forbidden, msg: '当前环境不能打开本机目录' }
}

function appUpdateUnavailable(): AjaxResult<never> {
  return { code: ErrorCodes.invalidConfig, msg: '当前运行形态不支持应用内更新' }
}

const silentLogger: LoggerGateway = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined
}

const PROJECT_DOCUMENT_ACCEPT = ['.md', '.markdown', '.txt'] as const
const PROJECT_MEDIA_KINDS = ['image', 'audio', 'video'] as const

/** 每次选择都按本次请求从同一份媒体后缀规则生成 accept；普通导入仍含文档。 */
function projectFileAcceptFor(mediaKinds?: readonly ProjectFileAssetKind[]): string {
  const requested = mediaKinds && mediaKinds.length > 0 ? mediaKinds : PROJECT_MEDIA_KINDS
  const media = mediaExtensionsForCategories(requested).map((extension) => `.${extension}`)
  const accepted =
    mediaKinds && mediaKinds.length > 0 ? media : [...PROJECT_DOCUMENT_ACCEPT, ...media]
  return accepted.join(',')
}

export function createBrowserDesktopBridge(): DesktopBridge {
  const listeners = new Set<(progress: ProjectProgressVO) => void>()
  const generationListeners = new Set<(progress: SceneGenerationRenderProgressEventVO) => void>()
  const previewRuntimeListeners = new Set<(event: unknown) => void>()
  const candidateReadyListeners = new Set<(event: unknown) => void>()
  const candidateFailedListeners = new Set<(event: unknown) => void>()
  const candidateInvalidatedListeners = new Set<(event: unknown) => void>()
  let generationSource: EventSource | undefined
  let previewRuntimeSource: EventSource | undefined
  let candidatePreviewSource: EventSource | undefined
  const search = new URLSearchParams(window.location.search)
  const realFiles = usesRealProjectFiles(search)
  let storedAppearance: AppearanceSettings | null = null
  const appearanceGateway: AppearanceSettingsGateway = {
    read: () => Promise.resolve(storedAppearance),
    save: (settings) => {
      storedAppearance = settings
      return Promise.resolve()
    }
  }
  const appearance = new AppearanceSettingsController(
    new ManageAppearanceSettings({ settings: appearanceGateway, logger: silentLogger }),
    new IpcExceptionHandler(silentLogger, new IpcErrorMapper())
  )
  let appearanceRequestSequence = 0
  const appearanceAccess = (): IpcRequestAccess => ({
    trusted: true,
    requestId: `browser-appearance-${++appearanceRequestSequence}`
  })

  function ensurePreviewRuntimeSource(): void {
    if (!realFiles || previewRuntimeSource) return
    const source = new EventSource('/__opengalgame/dev/scene-preview-runtime')
    source.onmessage = (message) => {
      let event: unknown
      try {
        event = JSON.parse(message.data)
      } catch {
        return
      }
      previewRuntimeListeners.forEach((listener) => listener(event))
    }
    previewRuntimeSource = source
  }

  function ensureCandidatePreviewSource(): void {
    if (!realFiles || candidatePreviewSource) return
    const source = new EventSource('/__opengalgame/dev/scene-preview-candidate')
    source.onmessage = (message) => {
      let event: unknown
      try {
        event = JSON.parse(message.data)
      } catch {
        return
      }
      if (typeof event !== 'object' || event === null || !('type' in event)) return
      const type = event.type
      const listeners =
        type === 'ready'
          ? candidateReadyListeners
          : type === 'stageFailed'
            ? candidateFailedListeners
            : type === 'invalidated'
              ? candidateInvalidatedListeners
              : null
      listeners?.forEach((listener) => listener(event))
    }
    candidatePreviewSource = source
  }

  function subscribeCandidate(
    listeners: Set<(event: unknown) => void>,
    listener: (event: unknown) => void
  ): () => void {
    if (!realFiles) return () => undefined
    listeners.add(listener)
    ensureCandidatePreviewSource()
    return () => {
      listeners.delete(listener)
    }
  }

  function devOrBlocked<T>(
    method: string,
    input: unknown,
    blocked: AjaxResult<never>
  ): Promise<AjaxResult<T>> {
    return realFiles ? callDev(method, input) : Promise.resolve(blocked)
  }

  function listenGenerationProgress(request: {
    projectId: string
    sceneId: string
    operationId: string
    threadId: string
    branchId: string
  }): void {
    generationSource?.close()
    const params = new URLSearchParams({
      projectId: request.projectId,
      sceneId: request.sceneId,
      operationId: request.operationId,
      threadId: request.threadId,
      branchId: request.branchId
    })
    const source = new EventSource(`/__opengalgame/dev/generation-progress?${params}`)
    generationSource = source
    source.onmessage = (message) => {
      const progress = JSON.parse(message.data) as SceneGenerationRenderProgressEventVO
      generationListeners.forEach((listener) => listener(progress))
    }
  }
  let failNextArrangement = false
  const workspaceMode = search.get('workspace')
  const homeFailure = search.get('homeFailure')
  let workspaceNotReady =
    !realFiles &&
    (workspaceMode === 'not-ready' ||
      workspaceMode === 'rebuilding' ||
      workspaceMode === 'rebuild-fail')

  const historyMode = search.get('history')
  const historyFixture =
    historyMode === 'fixture' || historyMode === 'empty' || historyMode === 'slow'
      ? createVersionHistoryFixture({
          empty: historyMode === 'empty',
          onUndo: () => {
            if (search.get('historyRefresh') === 'fail') failNextArrangement = true
          }
        })
      : null
  const generationFixture = realFiles
    ? null
    : createSceneGenerationFixture(search.get('generation'))
  let saved: ConnectionSettingsVO | null = null
  let pendingCreate: string | null = null
  let createdCount = 0
  let importedCount = 0
  const entries = createProjectFixtureStore()
  const picker = document.createElement('input')
  picker.type = 'file'
  picker.multiple = true
  picker.hidden = true
  picker.setAttribute('webkitdirectory', '')
  picker.setAttribute('directory', '')
  picker.setAttribute('data-testid', 'directory-picker')
  document.body.append(picker)
  const filePicker = document.createElement('input')
  filePicker.type = 'file'
  filePicker.multiple = true
  filePicker.hidden = true
  filePicker.accept = projectFileAcceptFor()
  filePicker.setAttribute('data-testid', 'project-file-picker')
  document.body.append(filePicker)

  function emit(progress: ProjectProgressVO): void {
    listeners.forEach((listener) => listener(progress))
  }

  function pickDirectory(): Promise<string | null> {
    return new Promise((resolve) => {
      const finish = (name: string | null): void => {
        picker.removeEventListener('change', onChange)
        picker.removeEventListener('cancel', onCancel)
        picker.value = ''
        resolve(name)
      }
      const onChange = (): void => {
        const file = picker.files?.[0]
        const relative = file?.webkitRelativePath || file?.name || ''
        finish(relative.split(/[/\\]/)[0] || file?.name || null)
      }
      const onCancel = (): void => finish(null)
      picker.addEventListener('change', onChange)
      picker.addEventListener('cancel', onCancel)
      picker.click()
    })
  }

  function pickProjectFiles(
    mediaKinds?: readonly ProjectFileAssetKind[]
  ): Promise<readonly File[] | null> {
    filePicker.accept = projectFileAcceptFor(mediaKinds)
    const { promise, resolve } = Promise.withResolvers<readonly File[] | null>()
    const finish = (files: readonly File[] | null): void => {
      filePicker.removeEventListener('change', onChange)
      filePicker.removeEventListener('cancel', onCancel)
      filePicker.value = ''
      filePicker.accept = projectFileAcceptFor()
      resolve(files)
    }
    const onChange = (): void => {
      const files = filePicker.files ? [...filePicker.files] : []
      finish(files.length > 0 ? files : null)
    }
    const onCancel = (): void => finish(null)
    filePicker.addEventListener('change', onChange)
    filePicker.addEventListener('cancel', onCancel)
    filePicker.click()
    return promise
  }

  async function runProject(
    operationId: string,
    kind: 'created' | 'imported',
    mapResult: (folder: string) => AjaxResult<ProjectOperationVO>,
    presetFolder?: string | null
  ): Promise<AjaxResult<ProjectOperationVO>> {
    emit({ operationId, stage: 'selecting' })
    const folder = presetFolder ?? (await pickDirectory())
    if (!folder) return { code: 2000, msg: '已取消', data: { status: 'cancelled' } }
    emit({ operationId, stage: 'inspecting' })
    emit({ operationId, stage: kind === 'created' ? 'initializing' : 'registering' })
    const result = mapResult(folder)
    if (result.code === 2000 && result.data?.status === 'completed') {
      emit({
        operationId,
        stage: 'completed',
        projectId: result.data.projectId,
        event: kind
      })
    }
    return result
  }

  return {
    chooseSaveLocation: async (): Promise<AjaxResult<ProjectSaveLocationVO | null>> => {
      if (realFiles) return callDev('chooseSaveLocation', undefined)
      const folder = await pickDirectory()
      if (!folder) return { code: 2000, msg: '已取消选择', data: null }
      pendingCreate = folder
      return { code: 2000, msg: '已选择保存位置', data: { directory: folder } }
    },
    clearSaveLocation: (): Promise<AjaxResult<null>> => {
      if (realFiles) return callDev('clearSaveLocation', undefined)
      pendingCreate = null
      return Promise.resolve({ code: 2000, msg: '操作成功', data: null })
    },
    createProject: (request: CreateProjectDTO) => {
      if (realFiles) return callDev('createProject', request)
      if (!request.name.trim()) {
        return Promise.resolve({ code: 1101, msg: '项目名称不能为空' })
      }
      const chosen = pendingCreate
      return runProject(
        request.operationId,
        'created',
        (folder) => {
          if (/fail|disk-full/i.test(folder)) {
            return { code: 1302, msg: '创建未完成：磁盘空间不足' }
          }
          const projectId = `browser-create-${++createdCount}`
          entries.set(projectId, {
            status: 'available',
            id: projectId,
            name: request.name.trim(),
            synopsis: request.synopsis ?? ''
          })
          if (homeFailure === 'create-with-id' || homeFailure === 'create-without-id') {
            if (homeFailure === 'create-without-id')
              return { code: 1309, msg: 'D:/secret/.git 损坏，锁文件无法读取' }
            return {
              code: 1309,
              msg: 'D:/secret/.git 损坏，锁文件无法读取',
              data: { status: 'completed', projectId, name: request.name.trim() }
            }
          }
          return {
            code: 2000,
            msg: '已创建',
            data: { status: 'completed', projectId, name: request.name.trim() }
          }
        },
        chosen
      ).then((result) => {
        if (result.code === 2000 && result.data?.status === 'completed') pendingCreate = null
        return result
      })
    },
    importProject: (request: ImportProjectDTO) => {
      if (realFiles) return callDev('importProject', request)
      return runProject(request.operationId, 'imported', (folder) => {
        if (/fail|disk-full/i.test(folder)) {
          return { code: 1302, msg: '导入未完成：磁盘空间不足' }
        }
        const projectId = `browser-import-${++importedCount}`
        entries.set(projectId, { status: 'available', id: projectId, name: folder, synopsis: '' })
        if (homeFailure === 'import')
          return { code: 1309, msg: 'D:/secret/.git 损坏，锁文件无法读取' }
        return {
          code: 2000,
          msg: '已导入',
          data: { status: 'completed', projectId, name: folder }
        }
      })
    },
    listProjects: (request: ListProjectsDTO) => {
      if (realFiles) return callDev('listProjects', request)
      if (readFixtureMode() === 'fail') {
        return Promise.resolve({ code: 5102, msg: '项目列表加载失败，请重试' })
      }
      const page = [...entries.values()].slice(request.offset, request.offset + request.limit)
      return Promise.resolve({
        code: 2000,
        msg: '项目列表读取成功',
        data: {
          entries: page,
          total: entries.size,
          offset: request.offset,
          limit: request.limit
        }
      })
    },
    openProject: (request: OpenProjectDTO) => {
      if (realFiles) return callDev('openProject', request)
      const entry = entries.get(request.id)
      if (!entry || entry.status !== 'available') {
        return Promise.resolve({
          code: entry ? entry.code : 1209,
          msg: entry ? entry.msg : '该项目未在本机列表中'
        })
      }
      return Promise.resolve({
        code: 2000,
        msg: '项目已打开',
        data: { id: entry.id, name: entry.name, synopsis: entry.synopsis }
      })
    },
    renameProject: (request: RenameProjectDTO) => {
      if (realFiles) return callDev('renameProject', request)
      const name = request.name.trim()
      if (!name) return Promise.resolve({ code: 1101, msg: '项目名称不能为空' })
      const entry = entries.get(request.id)
      if (!entry || entry.status !== 'available') {
        return Promise.resolve({
          code: entry ? entry.code : 1209,
          msg: entry ? entry.msg : '该项目未在本机列表中'
        })
      }
      const updated: ProjectListEntryVO = { ...entry, name, synopsis: request.synopsis ?? '' }
      entries.set(request.id, updated)
      return Promise.resolve({
        code: 2000,
        msg: '项目已重命名',
        data: { id: updated.id, name: updated.name, synopsis: updated.synopsis }
      })
    },
    ensureProjectWorkspace: (request: EnsureProjectWorkspaceDTO) => {
      if (realFiles) return callDev<ProjectWorkspaceVO>('ensureProjectWorkspace', request)
      if (workspaceNotReady) {
        const hold = workspaceMode === 'rebuilding' || workspaceMode === 'rebuild-fail'
        if (hold) {
          const { promise, resolve } = Promise.withResolvers<AjaxResult<ProjectWorkspaceVO>>()
          window.setTimeout(
            () =>
              resolve({
                code: 1309,
                msg: 'D:/secret/.git 损坏，锁文件无法读取'
              }),
            800
          )
          return promise
        }
        workspaceNotReady = false
      }
      const entry = entries.get(request.projectId)
      if (!entry || entry.status !== 'available') {
        return Promise.resolve({
          code: entry ? entry.code : 1209,
          msg: entry ? entry.msg : '该项目未在本机列表中'
        })
      }
      return Promise.resolve({
        code: 2000,
        msg: '工程工作区已核对',
        data: { projectId: request.projectId, sceneId: 'scene-1', canvasId: 'canvas-1' }
      })
    },
    inspectProjectWorkspace: (request: EnsureProjectWorkspaceDTO) => {
      if (realFiles)
        return callDev<ProjectWorkspaceInspectionVO>('inspectProjectWorkspace', request)
      const entry = entries.get(request.projectId)
      if (!entry || entry.status !== 'available') {
        return Promise.resolve({
          code: entry ? entry.code : 1209,
          msg: entry ? entry.msg : '该项目未在本机列表中'
        })
      }
      return Promise.resolve({
        code: 2000,
        msg: '工程工作区已检查',
        data: workspaceNotReady
          ? { ready: false, sceneId: 'scene-1', canvasId: 'canvas-1' }
          : { ready: true, sceneId: 'scene-1', canvasId: 'canvas-1' }
      })
    },
    inspectProjectFiles: (request) =>
      realFiles
        ? callDev('inspectProjectFiles', request)
        : Promise.resolve(fixtureInspect(request.projectId)),
    listProjectInputSources: (request) =>
      realFiles
        ? callDev('listProjectInputSources', request)
        : Promise.resolve(fixtureListSources(request.projectId)),
    readProjectInputSources: (request) =>
      realFiles
        ? callDev('readProjectInputSources', request)
        : Promise.resolve(fixtureReadSources(request.projectId, request.sourceIds)),
    readProjectMedia: (request) =>
      realFiles ? readDevMedia(request) : Promise.resolve(fileOperationUnavailable()),
    readSceneCanvasArrangement: (request) => {
      if (realFiles) return callDev('readSceneCanvasArrangement', request)
      if (failNextArrangement) {
        failNextArrangement = false
        return Promise.resolve({
          code: ErrorCodes.communicationFailed,
          msg: '当前环境不能读取工程文件'
        })
      }
      return Promise.resolve(fixtureReadArrangement(request.projectId))
    },
    createSceneCanvasSourceCard: (request) =>
      devOrBlocked('createSceneCanvasSourceCard', request, sceneCanvasUnavailable()),
    createSceneCanvasPromptCard: (request) =>
      devOrBlocked('createSceneCanvasPromptCard', request, sceneCanvasUnavailable()),
    createSceneCanvasFieldCard: (request) =>
      devOrBlocked('createSceneCanvasFieldCard', request, sceneCanvasUnavailable()),
    editSceneCanvasCard: (request) =>
      devOrBlocked('editSceneCanvasCard', request, sceneCanvasUnavailable()),
    editSceneCanvasPromptBody: (request) =>
      devOrBlocked('editSceneCanvasPromptBody', request, sceneCanvasUnavailable()),
    bindSceneCanvasFieldCardPreset: (request) =>
      devOrBlocked('bindSceneCanvasFieldCardPreset', request, sceneCanvasUnavailable()),
    editSceneCanvasMediaRole: (request) =>
      devOrBlocked('editSceneCanvasMediaRole', request, sceneCanvasUnavailable()),
    copySceneCanvasCard: (request) =>
      devOrBlocked('copySceneCanvasCard', request, sceneCanvasUnavailable()),
    deleteSceneCanvasCard: (request) =>
      devOrBlocked('deleteSceneCanvasCard', request, sceneCanvasUnavailable()),
    connectSceneCanvasCards: (request) =>
      devOrBlocked('connectSceneCanvasCards', request, sceneCanvasUnavailable()),
    disconnectSceneCanvasCards: (request) =>
      devOrBlocked('disconnectSceneCanvasCards', request, sceneCanvasUnavailable()),
    editSceneCanvasRelationName: (request) =>
      devOrBlocked('editSceneCanvasRelationName', request, sceneCanvasUnavailable()),
    attachSceneCanvasRelationRecord: (request) =>
      devOrBlocked('attachSceneCanvasRelationRecord', request, sceneCanvasUnavailable()),
    detachSceneCanvasRelationRecord: (request) =>
      devOrBlocked('detachSceneCanvasRelationRecord', request, sceneCanvasUnavailable()),
    saveSceneCanvasArrangement: (request) =>
      generationFixture
        ? Promise.resolve({ code: ErrorCodes.success, msg: '画布已保存（走查夹具）', data: null })
        : devOrBlocked('saveSceneCanvasArrangement', request, sceneCanvasUnavailable()),
    chooseProjectFiles: async (
      request?: ChooseProjectFilesDTO
    ): Promise<AjaxResult<readonly string[] | null>> => {
      const files = await pickProjectFiles(request?.mediaKinds)
      if (!files) {
        return { code: ErrorCodes.success, msg: '已取消选择', data: null }
      }
      if (!realFiles) {
        return { code: ErrorCodes.success, msg: '已选择文件', data: files.map((file) => file.name) }
      }
      const paths: string[] = []
      for (const file of files) {
        const staged = await stageDevFile(file)
        if (staged.code !== ErrorCodes.success || staged.data === undefined) {
          return { code: staged.code, msg: staged.msg }
        }
        paths.push(staged.data)
      }
      return { code: ErrorCodes.success, msg: '已选择文件', data: paths }
    },
    importProjectFiles: (request) =>
      realFiles
        ? callDev('importProjectFiles', request)
        : Promise.resolve(fixtureImportProjectFiles(request)),
    openProjectFile: (request) =>
      realFiles ? callDev('openProjectFile', request) : Promise.resolve(fileOperationUnavailable()),
    renameProjectFile: (request) =>
      realFiles
        ? callDev('renameProjectFile', request)
        : Promise.resolve(fileOperationUnavailable()),
    deleteProjectFile: (request) =>
      realFiles
        ? callDev('deleteProjectFile', request)
        : Promise.resolve(fileOperationUnavailable()),
    createProjectTextFile: (request) =>
      realFiles
        ? callDev('createProjectTextFile', request)
        : Promise.resolve(fileOperationUnavailable()),
    updateProjectTextFileBody: (request) =>
      realFiles
        ? callDev('updateProjectTextFileBody', request)
        : Promise.resolve(fileOperationUnavailable()),
    createProjectFolder: (request) =>
      realFiles
        ? callDev('createProjectFolder', request)
        : Promise.resolve(fileOperationUnavailable()),
    copyProjectFile: (request) =>
      realFiles ? callDev('copyProjectFile', request) : Promise.resolve(fileOperationUnavailable()),
    moveProjectFile: (request) =>
      realFiles ? callDev('moveProjectFile', request) : Promise.resolve(fileOperationUnavailable()),
    copyProjectFolder: (request) =>
      realFiles
        ? callDev('copyProjectFolder', request)
        : Promise.resolve(fileOperationUnavailable()),
    renameProjectFolder: (request) =>
      realFiles
        ? callDev('renameProjectFolder', request)
        : Promise.resolve(fileOperationUnavailable()),
    readProjectFolderDeletionPlan: (request) =>
      realFiles
        ? callDev('readProjectFolderDeletionPlan', request)
        : Promise.resolve(fileOperationUnavailable()),
    deleteProjectFolder: (request) =>
      realFiles
        ? callDev('deleteProjectFolder', request)
        : Promise.resolve(fileOperationUnavailable()),
    readProjectFileOperation: (request) =>
      realFiles
        ? callDev('readProjectFileOperation', request)
        : Promise.resolve(fileOperationUnavailable()),
    recoverProjectFileOperations: (request) =>
      realFiles
        ? callDev('recoverProjectFileOperations', request)
        : Promise.resolve(fileOperationUnavailable()),
    pathForDroppedFile: async (file) => {
      if (!realFiles) return fixturePathForDroppedFile(file)
      return stageDevFile(file)
    },
    unregisterProject: (request: UnregisterProjectDTO) => {
      if (realFiles) return callDev('unregisterProject', request)
      if (!entries.delete(request.id)) {
        return Promise.resolve({ code: 1209, msg: '该项目未在本机列表中' })
      }
      return Promise.resolve({ code: 2000, msg: '已从列表移出', data: { id: request.id } })
    },
    readAppearance: () =>
      realFiles
        ? callDev<AppearanceSettingsVO>('readAppearance', undefined)
        : appearance.readAppearance(undefined, appearanceAccess()),
    saveAppearance: (request) =>
      realFiles
        ? callDev<AppearanceSettingsVO>('saveAppearance', request)
        : appearance.saveAppearance(request, appearanceAccess()),
    getSettingsSummary: () =>
      realFiles
        ? callDev('getSettingsSummary', undefined)
        : Promise.resolve({ code: 2000, msg: 'ok', data: saved }),
    testConnection: (request: ConnectionSettingsDTO) => {
      if (realFiles) return callDev('testConnection', request)
      if (/fail-timeout/i.test(request.model)) {
        return Promise.resolve({ code: 1404, msg: '连接测试超时' })
      }
      if (/fail/i.test(request.model)) {
        return Promise.resolve({ code: 1405, msg: '无法连接模型服务' })
      }
      const result: AjaxResult<ConnectionTestVO> = {
        code: 2000,
        msg: 'ok',
        data: { available: true }
      }
      return Promise.resolve(result)
    },
    saveSettings: (request: ConnectionSettingsDTO) => {
      if (realFiles) return callDev('saveSettings', request)
      saved = {
        providerId: request.providerId,
        baseUrl: request.baseUrl,
        model: request.model,
        contextWindow: request.contextWindow,
        maxOutputTokens: request.maxOutputTokens,
        temperature: request.temperature,
        topP: request.topP,
        hasApiKey: request.apiKey.kind === 'replace' ? true : (saved?.hasApiKey ?? false),
        hasExtension:
          request.extension?.kind === 'set'
            ? true
            : request.extension?.kind === 'clear'
              ? false
              : (saved?.hasExtension ?? false)
      }
      return Promise.resolve({ code: 2000, msg: 'ok', data: saved })
    },
    listModels: (request: ListModelsDTO) => {
      if (realFiles) return callDev('listModels', request)
      if (/fail/i.test(request.baseUrl)) {
        return Promise.resolve({ code: 1405, msg: '无法连接模型服务' })
      }
      const result: AjaxResult<ModelListVO> = {
        code: 2000,
        msg: 'ok',
        data: { models: ['demo-chat', 'demo-long'] }
      }
      return Promise.resolve(result)
    },
    listVersionHistory: (request: ListVersionHistoryDTO) => {
      if (realFiles && !historyFixture) return callDev('listVersionHistory', request)
      if (!historyFixture) return Promise.resolve(versionHistoryUnavailable())
      if (historyMode === 'slow') {
        const { promise, resolve } = Promise.withResolvers<AjaxResult<VersionHistoryPageVO>>()
        window.setTimeout(() => resolve(historyFixture.listHistory(request)), 1600)
        return promise
      }
      return Promise.resolve(historyFixture.listHistory(request))
    },
    undoVersionHistoryEntry: (request: UndoVersionHistoryDTO) =>
      realFiles && !historyFixture
        ? callDev('undoVersionHistoryEntry', request)
        : Promise.resolve(
            historyFixture ? historyFixture.undoHistoryEntry(request) : versionHistoryUnavailable()
          ),
    clearVersionHistory: (request: ClearVersionHistoryDTO) =>
      realFiles && !historyFixture
        ? callDev('clearVersionHistory', request)
        : Promise.resolve(
            historyFixture ? historyFixture.clearHistory(request) : versionHistoryUnavailable()
          ),
    onProjectProgress: (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    startSceneGeneration: (request) =>
      generationFixture
        ? Promise.resolve(generationFixture.start(request))
        : devOrBlocked('startSceneGeneration', request, sceneGenerationUnavailable()),
    retrySceneGenerationRepair: (request) =>
      generationFixture
        ? Promise.resolve(generationFixture.retryRepair(request))
        : devOrBlocked('retrySceneGenerationRepair', request, sceneGenerationUnavailable()),
    getSceneGenerationStatus: (request) =>
      generationFixture
        ? Promise.resolve(generationFixture.status(request))
        : devOrBlocked('getSceneGenerationStatus', request, sceneGenerationUnavailable()),
    getLatestSceneGeneration: (request) =>
      devOrBlocked('getLatestSceneGeneration', request, sceneGenerationUnavailable()),
    replySceneGeneration: (request) =>
      generationFixture
        ? Promise.resolve(generationFixture.reply(request))
        : devOrBlocked('replySceneGeneration', request, sceneGenerationUnavailable()),
    pauseSceneGeneration: (request) =>
      generationFixture
        ? Promise.resolve(generationFixture.pause(request))
        : devOrBlocked('pauseSceneGeneration', request, sceneGenerationUnavailable()),
    resumeSceneGeneration: (request) =>
      generationFixture
        ? Promise.resolve(generationFixture.resume(request))
        : devOrBlocked('resumeSceneGeneration', request, sceneGenerationUnavailable()),
    cancelSceneGeneration: (request) =>
      generationFixture
        ? Promise.resolve(generationFixture.cancel(request))
        : devOrBlocked('cancelSceneGeneration', request, sceneGenerationUnavailable()),
    listSceneGenerationHistory: (request) =>
      generationFixture
        ? Promise.resolve(generationFixture.listHistory(request))
        : devOrBlocked('listSceneGenerationHistory', request, sceneGenerationUnavailable()),
    readSceneGenerationCheckpoint: (request) =>
      generationFixture
        ? Promise.resolve(generationFixture.readCheckpoint(request))
        : devOrBlocked('readSceneGenerationCheckpoint', request, sceneGenerationUnavailable()),
    forkSceneGeneration: (request) =>
      generationFixture
        ? Promise.resolve(generationFixture.fork(request))
        : devOrBlocked('forkSceneGeneration', request, sceneGenerationUnavailable()),
    openSceneGenerationPreview: (request) =>
      devOrBlocked('openSceneGenerationPreview', request, sceneGenerationUnavailable()),
    closeSceneGenerationPreview: (request) =>
      devOrBlocked('closeSceneGenerationPreview', request, sceneGenerationUnavailable()),
    subscribeSceneGenerationProgress: (request) => {
      if (generationFixture) {
        generationFixture.subscribeProgress(request, (event) => {
          generationListeners.forEach((listener) => listener(event))
        })
        return Promise.resolve({ code: ErrorCodes.success, msg: '已订阅', data: null })
      }
      if (!realFiles) return Promise.resolve(sceneGenerationUnavailable())
      listenGenerationProgress(request)
      return callDev('subscribeSceneGenerationProgress', request)
    },
    onSceneGenerationProgress: (listener) => {
      generationListeners.add(listener)
      return () => {
        generationListeners.delete(listener)
      }
    },
    readScenePreviewAvailability: (request) =>
      devOrBlocked('readScenePreviewAvailability', request, scenePreviewUnavailable()),
    openScenePreview: (request) =>
      devOrBlocked('openScenePreview', request, scenePreviewUnavailable()),
    preparePreviewStage: (request) =>
      devOrBlocked('preparePreviewStage', request, scenePreviewUnavailable()),
    previewDialogueDraft: (request) =>
      devOrBlocked('previewDialogueDraft', request, scenePreviewUnavailable()),
    saveDialogueChanges: (request) =>
      devOrBlocked('saveDialogueChanges', request, scenePreviewUnavailable()),
    readDialogueSaveSettlement: (request) =>
      devOrBlocked('readDialogueSaveSettlement', request, scenePreviewUnavailable()),
    selectPreviewDialogue: (request) =>
      devOrBlocked('selectPreviewDialogue', request, scenePreviewUnavailable()),
    playPreviousDialogue: (request) =>
      devOrBlocked('playPreviousDialogue', request, scenePreviewUnavailable()),
    playNextDialogue: (request) =>
      devOrBlocked('playNextDialogue', request, scenePreviewUnavailable()),
    closeScenePreview: (request) =>
      devOrBlocked('closeScenePreview', request, scenePreviewUnavailable()),
    subscribeScenePreviewRuntime: (request) => {
      ensurePreviewRuntimeSource()
      return devOrBlocked('subscribeScenePreviewRuntime', request, scenePreviewUnavailable())
    },
    onScenePreviewRuntime: (listener) => {
      if (!realFiles) return () => undefined
      previewRuntimeListeners.add(listener)
      ensurePreviewRuntimeSource()
      return () => {
        previewRuntimeListeners.delete(listener)
      }
    },
    readCandidatePreview: (request) =>
      devOrBlocked('readCandidatePreview', request, scenePreviewUnavailable()),
    readCandidatePreviewEvent: (request) =>
      devOrBlocked('readCandidatePreviewEvent', request, scenePreviewUnavailable()),
    onCandidatePreviewReady: (listener) => subscribeCandidate(candidateReadyListeners, listener),
    onCandidatePreviewStageFailed: (listener) =>
      subscribeCandidate(candidateFailedListeners, listener),
    onCandidatePreviewInvalidated: (listener) =>
      subscribeCandidate(candidateInvalidatedListeners, listener),
    exportSavedScene: (request) =>
      devOrBlocked('exportSavedScene', request, sceneExportUnavailable()),
    readLatestSavedSceneVersion: (request) =>
      devOrBlocked('readLatestSavedSceneVersion', request, latestSavedSceneVersionUnavailable()),
    chooseSceneExportDirectory: (request) =>
      devOrBlocked(
        'chooseSceneExportDirectory',
        request,
        chooseExportDirectoryUnavailable()
      ),
    checkForUpdate: () => Promise.resolve(appUpdateUnavailable()),
    downloadUpdate: () => Promise.resolve(appUpdateUnavailable()),
    installUpdate: () => Promise.resolve(appUpdateUnavailable()),
    readUpdateStatus: () =>
      Promise.resolve({
        code: ErrorCodes.success,
        msg: '更新状态已读取',
        data: { phase: 'idle', currentVersion: __APP_VERSION__, supported: false }
      }),
    onAppUpdateStatus: () => () => undefined,
    openDirectory: (request) => devOrBlocked('openDirectory', request, systemPathUnavailable())
  }
}
