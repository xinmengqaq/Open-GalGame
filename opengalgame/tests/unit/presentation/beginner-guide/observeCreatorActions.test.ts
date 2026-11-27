import { describe, expect, it } from 'vitest'

import type { ProjectInputSourceSummaryVO } from '@application/project-files/vo/ProjectInputSourceVO'
import type { SceneCanvasArrangementVO } from '@application/scene-canvas/vo/SceneCanvasArrangementVO'
import {
  createCreatorActionObservation,
  type CreatorActionObservation,
  type CreatorNavigation,
  type CreatorNavigationSnapshot
} from '@presentation/app/observeCreatorActions'
import {
  connectionConfigFingerprint,
  emptyConnectionExtensionDraft,
  type ConnectionDraftFields
} from '@presentation/features/connection-settings/connectionDraft'
import {
  advanceGuide,
  createGuideState,
  type GuideSessionState
} from '@presentation/features/beginner-guide/advanceGuide'
import type {
  GuideContextSnapshot,
  GuideFact,
  GuideScopeContext
} from '@presentation/features/beginner-guide/guideObservation'
import { GUIDE_STEP_ID } from '@presentation/features/beginner-guide/guideSteps'
import { useWorkbenchSessionStore } from '@presentation/features/workbench-session/workbenchSession.store'
import type { AppPage } from '@presentation/stores/navigation.store'

const EMPTY_SCOPE: GuideScopeContext = { projectId: null, sceneId: null, canvasId: null }

class FakeNavigation implements CreatorNavigation {
  private current: CreatorNavigationSnapshot = { page: 'home', projectId: null }
  private readonly listeners = new Set<(snapshot: CreatorNavigationSnapshot) => void>()

  get listenerCount(): number {
    return this.listeners.size
  }

  read(): CreatorNavigationSnapshot {
    return this.current
  }

  subscribe(listener: (snapshot: CreatorNavigationSnapshot) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  visit(page: AppPage): void {
    this.publish({
      page,
      projectId: page === 'workbench' ? this.current.projectId : null
    })
  }

  openWorkbench(projectId: string): void {
    this.publish({ page: 'workbench', projectId })
  }

  private publish(next: CreatorNavigationSnapshot): void {
    this.current = next
    for (const listener of [...this.listeners]) listener(next)
  }
}

function setup(): {
  navigation: FakeNavigation
  observation: CreatorActionObservation
  facts: GuideFact[]
  unsubscribe: () => void
} {
  const navigation = new FakeNavigation()
  const observation = createCreatorActionObservation({
    navigation,
    now: () => new Date('2026-11-22T10:00:00.000Z')
  })
  const facts: GuideFact[] = []
  const unsubscribe = observation.source.subscribe((fact) => facts.push(fact))
  return { navigation, observation, facts, unsubscribe }
}

function drain(facts: GuideFact[]): GuideFact[] {
  return facts.splice(0, facts.length)
}

function applyAll(state: GuideSessionState, facts: readonly GuideFact[]): GuideSessionState {
  return facts.reduce((current, fact) => advanceGuide(current, { type: 'fact', fact }).state, state)
}

describe('createCreatorActionObservation', () => {
  it('reads only the current page and project context', () => {
    const { navigation, observation } = setup()

    expect(observation.source.readCurrent()).toEqual({
      page: 'home',
      projectId: null,
      sceneId: null,
      canvasId: null,
      documentLayerCardId: null,
      saveState: 'unknown',
      arrangementStatus: 'unknown',
      previewOpen: false,
      generationDrawerOpen: false,
      mediaAvailability: { image: null, audio: null, video: null }
    })

    navigation.openWorkbench('project-a')
    expect(observation.source.readCurrent().page).toBe('workbench')
    expect(observation.source.readCurrent().projectId).toBe('project-a')
  })

  it('上下文提供当前画布卡片显示名，卡片改名后再次通知', () => {
    const { navigation, observation } = setup()
    useWorkbenchSessionStore.getState().reset()
    navigation.openWorkbench('project-a')
    useWorkbenchSessionStore.getState().startSession({
      projectId: 'project-a',
      projectName: '未寄出的第二封信',
      sceneId: 'scene-1',
      canvasId: 'canvas-1'
    })
    const arrangement = (title: string): SceneCanvasArrangementVO => ({
      projectId: 'project-a',
      sceneId: 'scene-1',
      canvasId: 'canvas-1',
      viewport: { x: 0, y: 0, zoom: 1 },
      cards: [
        {
          kind: 'image',
          cardId: 'card-1',
          sourceId: 'src-img',
          role: 'background',
          title,
          summary: '',
          layout: { x: 0, y: 0, width: 320, height: 208 }
        }
      ],
      relations: []
    })
    useWorkbenchSessionStore.getState().setArrangement(arrangement('dormitory.png'))
    expect(observation.source.readCurrent().cardTitles).toEqual({
      'card-1': 'dormitory.png'
    })

    const snapshots: GuideContextSnapshot[] = []
    const unsubscribe = observation.source.subscribeContext?.((snapshot) =>
      snapshots.push(snapshot)
    )
    useWorkbenchSessionStore.getState().setArrangement(arrangement('dormitory-renamed.png'))
    expect(snapshots.at(-1)?.cardTitles).toEqual({
      'card-1': 'dormitory-renamed.png'
    })
    unsubscribe?.()
  })

  it('按可读取、末后缀候选和已确认类别发布可用性，目录未读定时保持未知', () => {
    const { navigation, observation } = setup()
    useWorkbenchSessionStore.getState().reset()
    navigation.openWorkbench('project-a')
    expect(observation.source.readCurrent().mediaAvailability).toEqual({
      image: null,
      audio: null,
      video: null
    })

    useWorkbenchSessionStore.getState().startSession({
      projectId: 'project-a',
      projectName: '未寄出的第二封信',
      sceneId: 'scene-1',
      canvasId: 'canvas-1'
    })
    expect(observation.source.readCurrent().mediaAvailability).toEqual({
      image: null,
      audio: null,
      video: null
    })

    useWorkbenchSessionStore.getState().setCatalog([
      {
        sourceId: 'src-img',
        name: '屋顶.png',
        readable: true,
        parentFolderId: null,
        contentKind: 'image'
      }
    ])
    expect(observation.source.readCurrent().mediaAvailability).toEqual({
      image: true,
      audio: false,
      video: false
    })

    useWorkbenchSessionStore.getState().setCatalog([
      {
        sourceId: 'src-img',
        name: '屋顶.png',
        readable: false,
        parentFolderId: null,
        contentKind: 'image'
      },
      {
        sourceId: 'src-unknown',
        name: '封面.bin',
        readable: true,
        parentFolderId: null,
        contentKind: 'image'
      },
      {
        sourceId: 'src-audio',
        name: '脚步.WAV',
        readable: true,
        parentFolderId: null,
        contentKind: 'audio'
      }
    ])
    expect(observation.source.readCurrent().mediaAvailability).toEqual({
      image: false,
      audio: true,
      video: false
    })
    useWorkbenchSessionStore.getState().reset()
  })

  it('目录引用未变化时复用可用性，不重复扫描来源', () => {
    const { navigation, observation } = setup()
    useWorkbenchSessionStore.getState().reset()
    navigation.openWorkbench('project-a')
    useWorkbenchSessionStore.getState().startSession({
      projectId: 'project-a',
      projectName: '未寄出的第二封信',
      sceneId: 'scene-1',
      canvasId: 'canvas-1'
    })
    let nameReads = 0
    const image = {
      sourceId: 'src-img',
      readable: true,
      parentFolderId: null,
      contentKind: 'image'
    } as ProjectInputSourceSummaryVO
    Object.defineProperty(image, 'name', {
      enumerable: true,
      get() {
        nameReads += 1
        return '屋顶.png'
      }
    })
    useWorkbenchSessionStore.getState().setCatalog([image])

    expect(observation.source.readCurrent().mediaAvailability.image).toBe(true)
    const firstScanReads = nameReads
    expect(firstScanReads).toBe(1)

    observation.source.readCurrent()
    observation.source.readCurrent()
    expect(nameReads).toBe(firstScanReads)

    // 目录引用变化（重新载入同一批来源）才重新计算。
    useWorkbenchSessionStore.getState().setCatalog([image])
    expect(observation.source.readCurrent().mediaAvailability.image).toBe(true)
    expect(nameReads).toBe(firstScanReads + 1)
    useWorkbenchSessionStore.getState().reset()
  })

  it('发布上下文变化和试玩预览开关，退订后不再通知', () => {
    const { navigation, observation } = setup()
    const snapshots: GuideContextSnapshot[] = []
    const unsubscribe = observation.source.subscribeContext?.((snapshot) =>
      snapshots.push(snapshot)
    )

    expect(snapshots).toEqual([])
    navigation.openWorkbench('project-a')
    expect(snapshots.at(-1)).toMatchObject({
      page: 'workbench',
      projectId: 'project-a',
      previewOpen: false
    })

    observation.workbench.onPreviewVisibilityChanged?.(true)
    expect(snapshots.at(-1)?.previewOpen).toBe(true)
    expect(observation.source.readCurrent().previewOpen).toBe(true)

    observation.workbench.onPreviewVisibilityChanged?.(true)
    expect(snapshots).toHaveLength(2)

    observation.workbench.onPreviewVisibilityChanged?.(false)
    expect(snapshots.at(-1)?.previewOpen).toBe(false)

    observation.workbench.onGenerationDrawerVisibilityChanged?.(true)
    expect(snapshots.at(-1)?.generationDrawerOpen).toBe(true)
    expect(observation.source.readCurrent().generationDrawerOpen).toBe(true)

    observation.workbench.onGenerationDrawerVisibilityChanged?.(true)
    expect(snapshots).toHaveLength(4)

    observation.workbench.onGenerationDrawerVisibilityChanged?.(false)
    expect(snapshots.at(-1)?.generationDrawerOpen).toBe(false)

    unsubscribe?.()
    navigation.visit('home')
    expect(snapshots).toHaveLength(5)
  })

  it('试玩预览开关有独立订阅，不依赖教程阅读上下文', () => {
    const { observation } = setup()
    const states: boolean[] = []
    const unsubscribe = observation.source.subscribePreview?.((open) => states.push(open))
    observation.workbench.onPreviewVisibilityChanged?.(true)
    observation.workbench.onPreviewVisibilityChanged?.(true)
    observation.workbench.onPreviewVisibilityChanged?.(false)
    expect(states).toEqual([true, false])

    unsubscribe?.()
    observation.workbench.onPreviewVisibilityChanged?.(true)
    expect(states).toEqual([true, false])
    expect(observation.source.readCurrent().previewOpen).toBe(true)
  })

  it('subscribes to navigation only while it has listeners', () => {
    const navigation = new FakeNavigation()
    const observation = createCreatorActionObservation({ navigation })

    expect(navigation.listenerCount).toBe(0)
    const first = observation.source.subscribe(() => undefined)
    const second = observation.source.subscribe(() => undefined)
    expect(navigation.listenerCount).toBe(1)

    first()
    expect(navigation.listenerCount).toBe(1)
    second()
    expect(navigation.listenerCount).toBe(0)
  })

  it('does not emit config facts without a listener', () => {
    const navigation = new FakeNavigation()
    const observation = createCreatorActionObservation({ navigation })
    const facts: GuideFact[] = []

    observation.onConnectionTested('fp-1')
    observation.onConnectionSaved('fp-1')
    const unsubscribe = observation.source.subscribe((fact) => facts.push(fact))
    observation.onConnectionSaved('fp-1')

    expect(facts).toHaveLength(1)
    expect(facts[0]?.kind).toBe('configSaved')
    unsubscribe()
  })

  it('emits test failure and config change as narrow facts', () => {
    const { observation, facts } = setup()

    observation.onConnectionTestFailed('fp-1')
    const failed = drain(facts)
    expect(failed).toHaveLength(1)
    expect(failed[0]).toMatchObject({
      kind: 'configTestFailed',
      configFingerprint: 'fp-1',
      outcome: 'failed'
    })

    let state = applyAll(createGuideState({ scope: EMPTY_SCOPE }), failed)
    expect([state.stepId, state.milestoneIndex]).toEqual(['configure-model', 0])
    expect(state.prompt.title).toBe('连接还没测通')

    observation.onConnectionChanged()
    const changed = drain(facts)
    expect(changed).toHaveLength(1)
    expect(changed[0]).toMatchObject({ kind: 'configChanged', outcome: 'confirmed' })

    state = applyAll(state, changed)
    expect(state.prompt.title).toBe('先接通一个模型')
    expect(state.savedConfigFingerprint).toBeNull()
  })

  it('saves the config first, then advances only after a successful test', () => {
    const { observation, facts } = setup()
    const initial = createGuideState({ scope: EMPTY_SCOPE })

    observation.onConnectionSaved('fp-1')
    const afterSave = applyAll(initial, drain(facts))
    expect(afterSave.stepId).toBe(GUIDE_STEP_ID.configureModel)
    expect(afterSave.milestoneIndex).toBe(1)
    expect(afterSave.prompt.title).toBe('测试一下这份配置')

    observation.onConnectionTested('fp-1')
    const afterTest = applyAll(afterSave, drain(facts))
    expect(afterTest.stepId).toBe(GUIDE_STEP_ID.createProject)
    expect(afterTest.milestoneIndex).toBe(0)
  })

  it('does not advance when testing before any successful save', () => {
    const { observation, facts } = setup()

    observation.onConnectionTested('fp-1')
    const state = applyAll(createGuideState({ scope: EMPTY_SCOPE }), drain(facts))

    expect(state.stepId).toBe(GUIDE_STEP_ID.configureModel)
    expect(state.milestoneIndex).toBe(0)
  })

  it('returns to the save prompt after a saved config changes', () => {
    const { observation, facts } = setup()
    const initial = createGuideState({ scope: EMPTY_SCOPE })

    observation.onConnectionSaved('fp-1')
    const afterSave = applyAll(initial, drain(facts))

    observation.onConnectionChanged()
    const afterChange = applyAll(afterSave, drain(facts))
    expect(afterChange.stepId).toBe(GUIDE_STEP_ID.configureModel)
    expect(afterChange.milestoneIndex).toBe(0)
    expect(afterChange.savedConfigFingerprint).toBeNull()
    expect(afterChange.prompt.title).toBe('先接通一个模型')

    observation.onConnectionSaved('fp-2')
    const afterResave = applyAll(afterChange, drain(facts))
    expect(afterResave.milestoneIndex).toBe(1)

    observation.onConnectionTested('fp-2')
    const afterTest = applyAll(afterResave, drain(facts))
    expect(afterTest.stepId).toBe(GUIDE_STEP_ID.createProject)
  })

  it('does not advance twice for repeated success callbacks', () => {
    const { observation, facts } = setup()
    const initial = createGuideState({ scope: EMPTY_SCOPE })

    observation.onConnectionSaved('fp-1')
    let state = applyAll(initial, drain(facts))
    observation.onConnectionSaved('fp-1')
    state = applyAll(state, drain(facts))
    expect(state.stepId).toBe(GUIDE_STEP_ID.configureModel)
    expect(state.milestoneIndex).toBe(1)

    observation.onConnectionTested('fp-1')
    state = applyAll(state, drain(facts))
    expect(state.stepId).toBe(GUIDE_STEP_ID.createProject)

    observation.onConnectionTested('fp-1')
    state = applyAll(state, drain(facts))
    expect(state.stepId).toBe(GUIDE_STEP_ID.createProject)
    expect(state.milestoneIndex).toBe(0)
  })

  it('emits projectEntered only after the created project is entered', () => {
    const { navigation, observation, facts } = setup()
    const initial = createGuideState({
      stepId: GUIDE_STEP_ID.createProject,
      scope: EMPTY_SCOPE
    })

    observation.onProjectCreated('project-a')
    const createdFacts = drain(facts)
    expect(createdFacts).toHaveLength(1)
    expect(createdFacts[0]).toMatchObject({
      kind: 'projectCreated',
      outcome: 'confirmed',
      scope: { projectId: 'project-a' }
    })

    const afterCreated = applyAll(initial, createdFacts)
    expect(afterCreated.milestoneIndex).toBe(1)
    expect(afterCreated.createdProjectId).toBe('project-a')

    navigation.openWorkbench('project-a')
    const enteredFacts = drain(facts)
    expect(enteredFacts).toHaveLength(1)
    expect(enteredFacts[0]).toMatchObject({
      kind: 'projectEntered',
      outcome: 'confirmed',
      scope: { projectId: 'project-a' }
    })

    const afterEntered = applyAll(afterCreated, enteredFacts)
    expect(afterEntered.stepId).toBe(GUIDE_STEP_ID.importScript)
    expect(afterEntered.milestoneIndex).toBe(0)
  })

  it('does not treat opening an existing project as creating or entering', () => {
    const { navigation, facts } = setup()
    const initial = createGuideState({
      stepId: GUIDE_STEP_ID.createProject,
      scope: EMPTY_SCOPE
    })

    navigation.openWorkbench('existing-project')
    expect(facts).toHaveLength(0)

    const state = applyAll(initial, drain(facts))
    expect(state.stepId).toBe(GUIDE_STEP_ID.createProject)
    expect(state.milestoneIndex).toBe(0)
    expect(state.createdProjectId).toBeNull()
  })

  it('ignores a late entry after the creator switched away', () => {
    const { navigation, observation, facts } = setup()
    const initial = createGuideState({
      stepId: GUIDE_STEP_ID.createProject,
      scope: EMPTY_SCOPE
    })

    observation.onProjectCreated('project-a')
    const afterCreated = applyAll(initial, drain(facts))

    navigation.visit('projects')
    navigation.openWorkbench('project-a')
    expect(drain(facts)).toHaveLength(0)

    const state = applyAll(afterCreated, [])
    expect(state.stepId).toBe(GUIDE_STEP_ID.createProject)
    expect(state.milestoneIndex).toBe(1)
  })

  it('ignores a different project entry after creation', () => {
    const { navigation, observation, facts } = setup()
    const initial = createGuideState({
      stepId: GUIDE_STEP_ID.createProject,
      scope: EMPTY_SCOPE
    })

    observation.onProjectCreated('project-a')
    const afterCreated = applyAll(initial, drain(facts))

    navigation.openWorkbench('project-b')
    expect(drain(facts)).toHaveLength(0)

    navigation.openWorkbench('project-a')
    expect(drain(facts)).toHaveLength(0)

    const state = applyAll(afterCreated, [])
    expect(state.stepId).toBe(GUIDE_STEP_ID.createProject)
    expect(state.milestoneIndex).toBe(1)
  })

  it('ignores the same fact delivered twice', () => {
    const { observation, facts } = setup()
    observation.onConnectionSaved('fp-1')
    const savedFact = drain(facts)[0]
    expect(savedFact).toBeDefined()
    if (!savedFact) return

    const once = advanceGuide(createGuideState({ scope: EMPTY_SCOPE }), {
      type: 'fact',
      fact: savedFact
    }).state
    const twice = advanceGuide(once, { type: 'fact', fact: savedFact }).state

    expect(twice).toBe(once)
    expect(twice.milestoneIndex).toBe(1)
  })
})

describe('connectionConfigFingerprint', () => {
  const fields: ConnectionDraftFields = {
    providerId: 'openai-compatible',
    baseUrl: 'https://example.test/v1',
    model: 'test-model',
    contextWindow: '128000',
    maxOutputTokens: '32768',
    temperature: '0.7',
    topP: '0.9',
    apiKey: 'sk-secret-value'
  }

  it('is stable for the same config and opaque to secrets', () => {
    const first = connectionConfigFingerprint(fields, emptyConnectionExtensionDraft)
    const second = connectionConfigFingerprint({ ...fields }, emptyConnectionExtensionDraft)

    expect(first).toBe(second)
    expect(first).toMatch(/^cfg-/)
    expect(first).not.toContain(fields.apiKey)
    expect(first).not.toContain(fields.baseUrl)
  })

  it('changes when a field covered by the test invalidation changes', () => {
    const base = connectionConfigFingerprint(fields, emptyConnectionExtensionDraft)

    expect(
      connectionConfigFingerprint(
        { ...fields, apiKey: 'sk-other-value' },
        emptyConnectionExtensionDraft
      )
    ).not.toBe(base)
    expect(
      connectionConfigFingerprint(
        { ...fields, model: 'other-model' },
        emptyConnectionExtensionDraft
      )
    ).not.toBe(base)
    expect(
      connectionConfigFingerprint({ ...fields, temperature: '0.8' }, emptyConnectionExtensionDraft)
    ).not.toBe(base)
  })
})
