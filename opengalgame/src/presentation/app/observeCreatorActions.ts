import type { ProjectInputSourceSummaryVO } from '@application/project-files/vo/ProjectInputSourceVO'

import {
  GUIDE_MEDIA_KINDS,
  guideScopeContextOf,
  type GuideContextListener,
  type GuideContextSnapshot,
  type GuideFact,
  type GuideObservationListener,
  type GuideObservationSource,
  type GuidePage,
  type GuideScopeContext
} from '../features/beginner-guide/guideObservation'
import type { GuideMediaImportAction } from '../features/beginner-guide/guideMedia'
import {
  inputCatalogMediaAvailabilityOf,
  type InputCatalogMediaAvailability
} from '../features/input-catalog/inputCatalogMediaAvailability'
import { cardTitleText } from '../features/workbench-session/contentKindLabel'
import type { WorkbenchActionObservers } from '../features/workbench-session/workbenchActionObservers'
import { useWorkbenchSessionStore } from '../features/workbench-session/workbenchSession.store'
import type { WorkspaceLoadStatus } from '../features/workbench-session/workbenchSession.types'
import { useNavigationStore, type AppPage } from '../stores/navigation.store'
import type { ConfirmedFactBase, GuideActionFactContext } from './guideActionFactContext'
import { createCanvasActionObservation } from './observeCanvasActions'
import { createExportActionObservation } from './observeExportActions'
import { createGenerationActionObservation } from './observeGenerationActions'
import { createInputActionObservation } from './observeInputActions'
import { createPreviewActionObservation } from './observePreviewActions'

/** 导航的最小只读接口；生产使用 navigation.store，测试可注入假实现。 */
export interface CreatorNavigationSnapshot {
  readonly page: AppPage
  readonly projectId: string | null
}

export interface CreatorNavigation {
  read(): CreatorNavigationSnapshot
  subscribe(listener: (snapshot: CreatorNavigationSnapshot) => void): () => void
}

export interface CreatorActionObservation {
  readonly source: GuideObservationSource
  /** 工作台页面/adapter 上报的窄语义动作；由本观察源统一翻译成事实。 */
  readonly workbench: WorkbenchActionObservers
  /** 连接测试成功（业务已确认）时调用。 */
  readonly onConnectionTested: (configFingerprint: string) => void
  /** 连接测试失败（业务已确认）时调用；只用于原位提示。 */
  readonly onConnectionTestFailed: (configFingerprint: string) => void
  /** 测试过的配置被改动时调用；不携带草稿内容。 */
  readonly onConnectionChanged: () => void
  /** 连接设置保存成功（saveSettings 返回 true）时调用。 */
  readonly onConnectionSaved: (configFingerprint: string) => void
  /** 新建工程成功（created + completed）时调用。 */
  readonly onProjectCreated: (projectId: string) => void
  /** 教程选材入口：转发到文件区真实的 importFiles；未挂载文件区时返回 unavailable。 */
  readonly mediaImport: GuideMediaImportAction
  /** 文件区挂载/卸载时登记真实导入动作；页面不 import 新手引导。 */
  readonly bindMediaImport: (action: GuideMediaImportAction | null) => void
}

export interface CreatorActionObservationOptions {
  navigation?: CreatorNavigation
  now?: () => Date
}

function readNavigation(): CreatorNavigationSnapshot {
  const state = useNavigationStore.getState()
  return {
    page: state.page,
    projectId: state.openedProject?.id ?? null
  }
}

const defaultNavigation: CreatorNavigation = {
  read: readNavigation,
  subscribe(listener) {
    return useNavigationStore.subscribe(() => listener(readNavigation()))
  }
}

function guidePageOf(page: AppPage): GuidePage {
  switch (page) {
    case 'home':
      return 'home'
    case 'projects':
      return 'project-list'
    case 'workbench':
      return 'workbench'
  }
}

/**
 * 步骤 1–8 的真实观察源。
 *
 * 只观察已确认的业务结果：连接测试/保存成功、新建工程成功、同一工程真正进入
 * 工作台，以及工作台命令层在成功点上报的导入、卡片、阅读、连线、保存、摘要、
 * 生成、候选、预览保存和导出动作。页面通过 App 传入的窄回调报告结果；订阅只
 * 发生在有监听者时，最后一个监听者退出后解除导航订阅并丢弃未完成的进入等待。
 */
export function createCreatorActionObservation(
  options: CreatorActionObservationOptions = {}
): CreatorActionObservation {
  const navigation = options.navigation ?? defaultNavigation
  const now = options.now ?? (() => new Date())
  const listeners = new Set<GuideObservationListener>()
  const contextListeners = new Set<GuideContextListener>()
  const previewListeners = new Set<(open: boolean) => void>()
  let unsubscribeNavigation: (() => void) | null = null
  let unsubscribeContextStores: (() => void) | null = null
  let observedNavigation: CreatorNavigationSnapshot | null = null
  let observedContextKey: string | null = null
  let sequence = 0
  let pendingProjectId: string | null = null
  let previewOpen = false
  let generationDrawerOpen = false
  let boundMediaImport: GuideMediaImportAction | null = null
  let availabilityCache: {
    status: WorkspaceLoadStatus | null
    sources: readonly ProjectInputSourceSummaryVO[]
    value: InputCatalogMediaAvailability
  } | null = null

  // 目录未读定时不构造空数组；同一引用用于缓存命中。
  const emptySources: readonly ProjectInputSourceSummaryVO[] = []

  function readMediaAvailability(
    status: WorkspaceLoadStatus | null,
    sources: readonly ProjectInputSourceSummaryVO[]
  ): InputCatalogMediaAvailability {
    if (
      availabilityCache !== null &&
      availabilityCache.status === status &&
      availabilityCache.sources === sources
    ) {
      return availabilityCache.value
    }
    const value = inputCatalogMediaAvailabilityOf(status, sources)
    availabilityCache = { status, sources, value }
    return value
  }

  function bindMediaImport(action: GuideMediaImportAction | null): void {
    boundMediaImport = action
  }

  const mediaImport: GuideMediaImportAction = async (kind) => {
    if (!boundMediaImport) return 'unavailable'
    return boundMediaImport(kind)
  }

  function readCurrent(): GuideContextSnapshot {
    const current = navigation.read()
    const page = guidePageOf(current.page)
    const session = useWorkbenchSessionStore.getState()
    // 只有导航和工作台会话指向同一工程时才暴露场景/画布，避免切工程时读到旧会话。
    const inSession =
      page === 'workbench' && current.projectId !== null && session.projectId === current.projectId
    const catalogStatus = inSession ? session.catalogStatus : null
    const sources = inSession ? session.sources : emptySources
    const cardTitles = inSession
      ? Object.fromEntries(session.cards.map((card) => [card.cardId, cardTitleText(card)]))
      : undefined
    return {
      page,
      projectId: current.projectId,
      sceneId: inSession ? session.sceneId : null,
      canvasId: inSession ? session.canvasId : null,
      documentLayerCardId: inSession ? session.documentLayerCardId : null,
      saveState: inSession ? session.saveState : 'unknown',
      arrangementStatus: inSession ? session.arrangementStatus : 'unknown',
      previewOpen,
      generationDrawerOpen,
      mediaAvailability: readMediaAvailability(catalogStatus, sources),
      ...(cardTitles ? { cardTitles } : {})
    }
  }

  function currentScope(): GuideScopeContext {
    return guideScopeContextOf(readCurrent())
  }

  function contextKeyOf(snapshot: GuideContextSnapshot): string {
    const mediaKey = GUIDE_MEDIA_KINDS.map((kind) => {
      const available = snapshot.mediaAvailability[kind]
      return available === null ? '?' : available ? '1' : '0'
    }).join('')
    const cardKey = Object.entries(snapshot.cardTitles ?? {})
      .map(([cardId, title]) => `${cardId}=${title}`)
      .sort()
      .join(',')
    return [
      snapshot.page,
      snapshot.projectId ?? '',
      snapshot.sceneId ?? '',
      snapshot.canvasId ?? '',
      snapshot.previewOpen ? '1' : '0',
      snapshot.generationDrawerOpen ? '1' : '0',
      mediaKey,
      cardKey
    ].join('|')
  }

  function notifyContext(): void {
    if (contextListeners.size === 0) return
    const snapshot = readCurrent()
    const key = contextKeyOf(snapshot)
    if (key === observedContextKey) return
    observedContextKey = key
    for (const listener of [...contextListeners]) {
      try {
        listener(snapshot)
      } catch {
        // 指引观察者异常不能打断导航或工作台操作。
      }
    }
  }

  function subscribeContext(listener: GuideContextListener): () => void {
    contextListeners.add(listener)
    if (contextListeners.size === 1) {
      observedContextKey = contextKeyOf(readCurrent())
      const unsubscribeNavigationStore = navigation.subscribe(() => notifyContext())
      const unsubscribeSessionStore = useWorkbenchSessionStore.subscribe(() => notifyContext())
      unsubscribeContextStores = () => {
        unsubscribeNavigationStore()
        unsubscribeSessionStore()
      }
    }

    let active = true
    return () => {
      if (!active) return
      active = false
      contextListeners.delete(listener)
      if (contextListeners.size > 0) return
      unsubscribeContextStores?.()
      unsubscribeContextStores = null
      observedContextKey = null
    }
  }

  function subscribePreview(listener: (open: boolean) => void): () => void {
    previewListeners.add(listener)
    return () => {
      previewListeners.delete(listener)
    }
  }

  function onPreviewVisibilityChanged(open: boolean): void {
    if (previewOpen === open) return
    previewOpen = open
    notifyContext()
    for (const listener of [...previewListeners]) {
      try {
        listener(open)
      } catch {
        // 指引观察者异常不能打断试玩预览的打开或关闭。
      }
    }
  }

  function onGenerationDrawerVisibilityChanged(open: boolean): void {
    if (generationDrawerOpen === open) return
    generationDrawerOpen = open
    notifyContext()
  }

  function factBase(): ConfirmedFactBase {
    sequence += 1
    return {
      outcome: 'confirmed',
      sequence,
      occurredAt: now().toISOString()
    }
  }

  function emit(fact: GuideFact): void {
    for (const listener of [...listeners]) {
      try {
        listener(fact)
      } catch {
        // 指引观察者异常不能打断创作者的保存或创建动作。
      }
    }
  }

  function emitProjectEntered(projectId: string): void {
    emit({
      kind: 'projectEntered',
      scope: { projectId, sceneId: null, canvasId: null },
      ...factBase()
    })
  }

  const actionFactContext: GuideActionFactContext = {
    active: () => listeners.size > 0,
    readCurrent,
    factBase,
    emit
  }
  const inputActions = createInputActionObservation(actionFactContext)
  const canvasActions = createCanvasActionObservation(actionFactContext)
  const generationActions = createGenerationActionObservation(actionFactContext)
  const previewActions = createPreviewActionObservation(actionFactContext)
  const exportActions = createExportActionObservation(actionFactContext)
  const workbench: WorkbenchActionObservers = {
    ...generationActions,
    ...previewActions,
    ...exportActions,
    onSourceImported: (source) => inputActions.onSourceImported(source),
    onCardCreated: (card) => canvasActions.onCardCreated(card),
    onCardSelected: (card) => canvasActions.onCardSelected(card),
    onCardDeleted: (card) => canvasActions.onCardDeleted(card),
    onDocumentOpened: (event) => canvasActions.onDocumentOpened(event),
    onDocumentClosed: (event) => canvasActions.onDocumentClosed(event),
    onCardEdited: (event) => canvasActions.onCardEdited(event),
    onPromptBodySaved: (event) => canvasActions.onPromptBodySaved(event),
    onRelationCreated: (event) => canvasActions.onRelationCreated(event),
    onRelationNamed: (event) => canvasActions.onRelationNamed(event),
    onRelationDeleted: (event) => canvasActions.onRelationDeleted(event),
    onCanvasSaved: (event) => canvasActions.onCanvasSaved(event),
    onInputSummaryOpened: (event) => canvasActions.onInputSummaryOpened(event),
    onPreviewVisibilityChanged,
    onGenerationDrawerVisibilityChanged
  }

  function handleNavigation(current: CreatorNavigationSnapshot): void {
    if (pendingProjectId === null) return
    if (current.page === 'workbench' && current.projectId === pendingProjectId) {
      const projectId = pendingProjectId
      pendingProjectId = null
      emitProjectEntered(projectId)
      return
    }
    // 创建成功后先去了别处，或进入了另一个工程：这次创建不构成“进入新工程”。
    pendingProjectId = null
  }

  function handleNavigationChange(current: CreatorNavigationSnapshot): void {
    const previous = observedNavigation
    observedNavigation = current
    if (
      previous !== null &&
      previous.page === current.page &&
      previous.projectId === current.projectId
    ) {
      return
    }
    handleNavigation(current)
  }

  function onConnectionTested(configFingerprint: string): void {
    if (listeners.size === 0) return
    emit({
      kind: 'configTested',
      configFingerprint,
      scope: currentScope(),
      ...factBase()
    })
  }

  function onConnectionTestFailed(configFingerprint: string): void {
    if (listeners.size === 0) return
    const base = factBase()
    emit({
      kind: 'configTestFailed',
      configFingerprint,
      scope: currentScope(),
      ...base,
      outcome: 'failed'
    })
  }

  function onConnectionChanged(): void {
    if (listeners.size === 0) return
    emit({
      kind: 'configChanged',
      scope: currentScope(),
      ...factBase()
    })
  }

  function onConnectionSaved(configFingerprint: string): void {
    if (listeners.size === 0) return
    emit({
      kind: 'configSaved',
      configFingerprint,
      scope: currentScope(),
      ...factBase()
    })
  }

  function onProjectCreated(projectId: string): void {
    if (listeners.size === 0) return
    pendingProjectId = projectId
    emit({
      kind: 'projectCreated',
      scope: { projectId, sceneId: null, canvasId: null },
      ...factBase()
    })

    // 创建流程可能先 openWorkbench 再回调；此时等不到下一次导航变化，直接确认进入。
    if (pendingProjectId === null) return
    const current = navigation.read()
    if (current.page === 'workbench' && current.projectId === projectId) {
      pendingProjectId = null
      emitProjectEntered(projectId)
    }
  }

  function subscribe(listener: GuideObservationListener): () => void {
    listeners.add(listener)
    if (listeners.size === 1) {
      observedNavigation = navigation.read()
      unsubscribeNavigation = navigation.subscribe(handleNavigationChange)
    }

    let active = true
    return () => {
      if (!active) return
      active = false
      listeners.delete(listener)
      if (listeners.size > 0) return
      unsubscribeNavigation?.()
      unsubscribeNavigation = null
      observedNavigation = null
      pendingProjectId = null
    }
  }

  return {
    source: { subscribe, readCurrent, subscribeContext, subscribePreview },
    workbench,
    onConnectionTested,
    onConnectionTestFailed,
    onConnectionChanged,
    onConnectionSaved,
    onProjectCreated,
    mediaImport,
    bindMediaImport
  }
}
