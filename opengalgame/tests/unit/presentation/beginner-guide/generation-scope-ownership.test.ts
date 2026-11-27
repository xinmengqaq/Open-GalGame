import { afterEach, describe, expect, it } from 'vitest'

import {
  createCreatorActionObservation,
  type CreatorActionObservation,
  type CreatorNavigation,
  type CreatorNavigationSnapshot
} from '@presentation/app/observeCreatorActions'
import { createDefaultGuidePreferences } from '@presentation/features/beginner-guide/guidePreferences'
import type {
  CandidateReadyFact,
  CanvasSavedFact,
  GenerationStartedFact,
  GuideFact,
  InputSummaryOpenedFact,
  ProjectCreatedFact
} from '@presentation/features/beginner-guide/guideObservation'
import { GUIDE_STEP_ID } from '@presentation/features/beginner-guide/guideSteps'
import {
  createGuideSessionModel,
  guideSessionReduce,
  type GuideSessionModel
} from '@presentation/features/beginner-guide/useGuideSession'
import { useWorkbenchSessionStore } from '@presentation/features/workbench-session/workbenchSession.store'
import type { AppPage } from '@presentation/stores/navigation.store'
import { TEST_SCOPE, fact } from './guideFacts'

const PROJECT_A = TEST_SCOPE.projectId
const PROJECT_B = 'project-2'
const A_SCENE_1 = TEST_SCOPE
const A_SCENE_2 = { projectId: PROJECT_A, sceneId: 'scene-2', canvasId: 'canvas-2' }
const B_SCOPE = { projectId: PROJECT_B, sceneId: 'scene-b', canvasId: 'canvas-b' }
const EMPTY_SCOPE = { projectId: null, sceneId: null, canvasId: null }
const PARTIAL_SCOPE = { projectId: PROJECT_A, sceneId: null, canvasId: null }

class FakeNavigation implements CreatorNavigation {
  private current: CreatorNavigationSnapshot = { page: 'workbench', projectId: PROJECT_A }
  private readonly listeners = new Set<(snapshot: CreatorNavigationSnapshot) => void>()

  read(): CreatorNavigationSnapshot {
    return this.current
  }

  subscribe(listener: (snapshot: CreatorNavigationSnapshot) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  visit(page: AppPage, projectId: string | null = null): void {
    this.current = { page, projectId }
    for (const listener of [...this.listeners]) listener(this.current)
  }
}

function startWorkbench(scope: { projectId: string; sceneId: string; canvasId: string }): void {
  useWorkbenchSessionStore.getState().reset()
  useWorkbenchSessionStore.getState().startSession({
    projectId: scope.projectId,
    projectName: scope.projectId,
    sceneId: scope.sceneId,
    canvasId: scope.canvasId
  })
}

function sessionAtStepFive(): GuideSessionModel {
  let model = createGuideSessionModel(createDefaultGuidePreferences())
  model = guideSessionReduce(
    model,
    {
      type: 'start-tutorial',
      stepId: GUIDE_STEP_ID.saveAndGenerate,
      scope: A_SCENE_1
    },
    null
  )
  model = guideSessionReduce(
    model,
    {
      type: 'fact',
      fact: fact<CanvasSavedFact>({ kind: 'canvasSaved', reason: 'manual' })
    },
    null
  )
  return guideSessionReduce(
    model,
    {
      type: 'fact',
      fact: fact<InputSummaryOpenedFact>({ kind: 'inputSummaryOpened' })
    },
    null
  )
}

function syncContext(
  model: GuideSessionModel,
  scope: typeof A_SCENE_1
): GuideSessionModel {
  return guideSessionReduce(model, { type: 'sync-context', scope, page: 'workbench' }, null)
}

const cleanup: Array<() => void> = []

afterEach(() => {
  while (cleanup.length > 0) cleanup.pop()?.()
  useWorkbenchSessionStore.getState().reset()
})

interface OwnershipHarness {
  navigation: FakeNavigation
  facts: GuideFact[]
  observation: CreatorActionObservation
  state: { model: GuideSessionModel }
}

function observeSession(model: GuideSessionModel): OwnershipHarness {
  const navigation = new FakeNavigation()
  const observation = createCreatorActionObservation({ navigation })
  const state = { model }
  const facts: GuideFact[] = []
  const unsubscribe = observation.source.subscribe((nextFact) => {
    facts.push(nextFact)
    state.model = guideSessionReduce(state.model, { type: 'fact', fact: nextFact }, null)
  })
  cleanup.push(unsubscribe)
  return {
    navigation,
    facts,
    observation,
    state
  }
}

function observe(): OwnershipHarness {
  startWorkbench(A_SCENE_1)
  return observeSession(sessionAtStepFive())
}

describe('生成事实的练习归属', () => {
  it('暂停绑定 A 时切到 B 工程，A 的启动回执仍保存，回 A 接候选', () => {
    const harness = observe()
    harness.navigation.visit('projects', null)
    startWorkbench(B_SCOPE)
    harness.navigation.visit('workbench', PROJECT_B)

    harness.state.model = syncContext(harness.state.model, B_SCOPE)
    expect(harness.state.model.guide?.status).toBe('paused')

    harness.observation.workbench.onGenerationStarted?.({
      scope: A_SCENE_1,
      operationId: 'operation-a',
      saveVerified: true
    })
    expect(harness.facts.map((nextFact) => nextFact.kind)).toContain('generationStarted')
    expect(
      harness.state.model.pausedFacts.map((entry) => entry.fact.kind)
    ).toContain('generationStarted')
    expect(harness.state.model.guide?.status).toBe('paused')
    expect(harness.state.model.guide?.scope).toEqual(A_SCENE_1)

    startWorkbench(A_SCENE_1)
    harness.navigation.visit('workbench', PROJECT_A)
    harness.state.model = syncContext(harness.state.model, A_SCENE_1)
    harness.state.model = guideSessionReduce(
      harness.state.model,
      { type: 'resume', scope: A_SCENE_1 },
      null
    )
    expect(harness.state.model.guide?.generationOperationId).toBe('operation-a')
    expect(harness.state.model.guide?.generationRunState).toBe('running')

    harness.observation.workbench.onCandidateReady?.({
      scope: A_SCENE_1,
      candidateSnapshotId: 'candidate-a',
      operationId: 'operation-a',
      previewAvailable: true
    })
    expect(harness.state.model.guide?.stepId).toBe(GUIDE_STEP_ID.playtestCandidate)
    expect(harness.state.model.guide?.activeCandidateSnapshotId).toBe('candidate-a')
  })

  it('暂停绑定 A 场景 1 时切到场景 2，A 场景 1 的启动回执仍保存，回场景 1 接候选', () => {
    const harness = observe()
    startWorkbench(A_SCENE_2)
    harness.navigation.visit('workbench', PROJECT_A)

    harness.state.model = syncContext(harness.state.model, A_SCENE_2)
    expect(harness.state.model.guide?.status).toBe('paused')

    harness.observation.workbench.onGenerationStarted?.({
      scope: A_SCENE_1,
      operationId: 'operation-scene-1',
      saveVerified: true
    })
    expect(harness.facts.map((nextFact) => nextFact.kind)).toContain('generationStarted')
    expect(
      harness.state.model.pausedFacts.map((entry) => entry.fact.kind)
    ).toContain('generationStarted')

    startWorkbench(A_SCENE_1)
    harness.navigation.visit('workbench', PROJECT_A)
    harness.state.model = syncContext(harness.state.model, A_SCENE_1)
    harness.state.model = guideSessionReduce(
      harness.state.model,
      { type: 'resume', scope: A_SCENE_1 },
      null
    )
    expect(harness.state.model.guide?.generationOperationId).toBe('operation-scene-1')

    harness.observation.workbench.onCandidateReady?.({
      scope: A_SCENE_1,
      candidateSnapshotId: 'candidate-scene-1',
      operationId: 'operation-scene-1',
      previewAvailable: true
    })
    expect(harness.state.model.guide?.stepId).toBe(GUIDE_STEP_ID.playtestCandidate)
    expect(harness.state.model.guide?.activeCandidateSnapshotId).toBe('candidate-scene-1')
  })

  it('已在 B 继续后，A 的迟到启动和候选不暂停、不推进 B', () => {
    const harness = observe()
    startWorkbench(B_SCOPE)
    harness.navigation.visit('workbench', PROJECT_B)

    harness.state.model = syncContext(harness.state.model, B_SCOPE)
    harness.state.model = guideSessionReduce(
      harness.state.model,
      { type: 'resume', scope: B_SCOPE },
      null
    )
    expect(harness.state.model.guide?.status).toBe('following')
    expect(harness.state.model.guide?.scope).toEqual(B_SCOPE)
    expect(harness.state.model.guide?.milestoneIndex).toBe(0)

    harness.observation.workbench.onGenerationStarted?.({
      scope: A_SCENE_1,
      operationId: 'operation-a',
      saveVerified: true
    })
    harness.observation.workbench.onCandidateReady?.({
      scope: A_SCENE_1,
      candidateSnapshotId: 'candidate-a',
      operationId: 'operation-a',
      previewAvailable: true
    })
    expect(harness.facts.map((nextFact) => nextFact.kind)).toEqual([
      'generationStarted',
      'candidateReady'
    ])
    expect(harness.state.model.guide?.status).toBe('following')
    expect(harness.state.model.guide?.scope).toEqual(B_SCOPE)
    expect(harness.state.model.guide?.milestoneIndex).toBe(0)
    expect(harness.state.model.guide?.generationOperationId).toBeNull()
    expect(harness.state.model.guide?.activeCandidateSnapshotId).toBeNull()

    const lateStarted = fact<GenerationStartedFact>({
      kind: 'generationStarted',
      operationId: 'operation-a-late',
      scope: A_SCENE_1
    })
    harness.state.model = guideSessionReduce(
      harness.state.model,
      { type: 'fact', fact: lateStarted },
      null
    )
    expect(harness.state.model.guide?.status).toBe('following')
    expect(harness.state.model.guide?.scope).toEqual(B_SCOPE)
    expect(harness.state.model.guide?.milestoneIndex).toBe(0)
  })

  it('第 1 步空 scope 收到迟到 start/ready 不建立绑定，同步项目页仍 following', () => {
    let model = createGuideSessionModel(createDefaultGuidePreferences())
    model = guideSessionReduce(
      model,
      { type: 'start-tutorial', stepId: GUIDE_STEP_ID.configureModel },
      null
    )
    startWorkbench(A_SCENE_1)
    const harness = observeSession(model)
    expect(harness.state.model.guide?.scope).toEqual(EMPTY_SCOPE)

    harness.observation.workbench.onGenerationStarted?.({
      scope: A_SCENE_1,
      operationId: 'operation-empty-start',
      saveVerified: true
    })
    harness.observation.workbench.onCandidateReady?.({
      scope: A_SCENE_1,
      candidateSnapshotId: 'candidate-empty',
      operationId: 'operation-empty-start',
      previewAvailable: true
    })
    harness.observation.workbench.onCardCreated?.({
      scope: A_SCENE_1,
      cardId: 'late-card',
      cardKind: 'image'
    })
    expect(harness.facts.map((nextFact) => nextFact.kind)).toEqual([
      'generationStarted',
      'candidateReady',
      'cardCreated'
    ])
    expect(harness.state.model.guide?.status).toBe('following')
    expect(harness.state.model.guide?.scope).toEqual(EMPTY_SCOPE)

    harness.state.model = guideSessionReduce(
      harness.state.model,
      { type: 'sync-context', scope: EMPTY_SCOPE, page: 'project-list' },
      null
    )
    expect(harness.state.model.guide?.status).toBe('following')
    expect(harness.state.model.guide?.scope).toEqual(EMPTY_SCOPE)

    harness.state.model = guideSessionReduce(harness.state.model, { type: 'open-catalog' }, null)
    harness.observation.workbench.onGenerationStarted?.({
      scope: A_SCENE_1,
      operationId: 'operation-empty-catalog',
      saveVerified: true
    })
    expect(harness.state.model.deferredFacts).toHaveLength(0)
    harness.state.model = guideSessionReduce(harness.state.model, { type: 'close-catalog' }, null)

    harness.state.model = guideSessionReduce(harness.state.model, { type: 'pause' }, null)
    harness.observation.workbench.onGenerationStarted?.({
      scope: A_SCENE_1,
      operationId: 'operation-empty-paused',
      saveVerified: true
    })
    expect(harness.state.model.pausedFacts).toHaveLength(0)
    harness.state.model = guideSessionReduce(
      harness.state.model,
      { type: 'resume', scope: EMPTY_SCOPE },
      null
    )
    expect(harness.state.model.guide?.status).toBe('following')
    expect(harness.state.model.guide?.scope).toEqual(EMPTY_SCOPE)
  })

  it('第 2 步部分 scope 保留建工程事实，迟到生成事件不补场景，同步项目页仍 following', () => {
    let model = createGuideSessionModel(createDefaultGuidePreferences())
    model = guideSessionReduce(
      model,
      {
        type: 'start-tutorial',
        stepId: GUIDE_STEP_ID.createProject,
        scope: PARTIAL_SCOPE
      },
      null
    )
    const harness = observeSession(model)
    harness.state.model = guideSessionReduce(
      harness.state.model,
      {
        type: 'fact',
        fact: fact<ProjectCreatedFact>({
          kind: 'projectCreated',
          scope: PARTIAL_SCOPE
        })
      },
      null
    )
    expect(harness.state.model.guide?.scope).toEqual(PARTIAL_SCOPE)
    expect(harness.state.model.guide?.milestoneIndex).toBe(1)

    harness.observation.workbench.onGenerationStarted?.({
      scope: A_SCENE_1,
      operationId: 'operation-partial-start',
      saveVerified: true
    })
    harness.observation.workbench.onCandidateReady?.({
      scope: A_SCENE_1,
      candidateSnapshotId: 'candidate-partial',
      operationId: 'operation-partial-start',
      previewAvailable: true
    })
    expect(harness.state.model.guide?.status).toBe('following')
    expect(harness.state.model.guide?.scope).toEqual(PARTIAL_SCOPE)
    expect(harness.state.model.guide?.milestoneIndex).toBe(1)

    harness.state.model = guideSessionReduce(
      harness.state.model,
      { type: 'sync-context', scope: EMPTY_SCOPE, page: 'project-list' },
      null
    )
    expect(harness.state.model.guide?.status).toBe('following')
    expect(harness.state.model.guide?.scope).toEqual(PARTIAL_SCOPE)

    harness.state.model = guideSessionReduce(harness.state.model, { type: 'pause' }, null)
    harness.observation.workbench.onGenerationStarted?.({
      scope: A_SCENE_1,
      operationId: 'operation-partial-paused',
      saveVerified: true
    })
    expect(harness.state.model.pausedFacts).toHaveLength(0)
    harness.state.model = guideSessionReduce(
      harness.state.model,
      { type: 'resume', scope: EMPTY_SCOPE },
      null
    )
    expect(harness.state.model.guide?.status).toBe('following')
    expect(harness.state.model.guide?.scope).toEqual(PARTIAL_SCOPE)
    expect(harness.state.model.guide?.milestoneIndex).toBe(1)
  })
})
