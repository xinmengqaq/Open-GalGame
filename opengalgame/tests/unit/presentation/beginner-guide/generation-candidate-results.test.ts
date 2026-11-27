// @vitest-environment jsdom

import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type {
  SceneGenerationHistoryPageVO,
  SceneGenerationRenderInteractionVO,
  SceneGenerationRenderProgressEventVO,
  SceneGenerationRenderStatusVO
} from '@application/scene-generation/vo/SceneGenerationRenderVO'
import type { AjaxResult } from '@common/contracts/AjaxResult'
import { ErrorCodes } from '@common/errors/ErrorCodes'
import type { ProjectClient } from '@interfaces/client/ProjectClient'
import type { SceneGenerationClient } from '@interfaces/scene-generation/client/SceneGenerationClient'
import {
  createCreatorActionObservation,
  type CreatorActionObservation,
  type CreatorNavigation,
  type CreatorNavigationSnapshot
} from '@presentation/app/observeCreatorActions'
import {
  advanceGuide,
  createGuideState,
  type GuideSessionState
} from '@presentation/features/beginner-guide/advanceGuide'
import type {
  CandidateReadyFact,
  CanvasSavedFact,
  GenerationFailedFact,
  GenerationStartedFact,
  GuideFact,
  InputSummaryOpenedFact
} from '@presentation/features/beginner-guide/guideObservation'
import { GUIDE_STEP_ID } from '@presentation/features/beginner-guide/guideSteps'
import { createDefaultGuidePreferences } from '@presentation/features/beginner-guide/guidePreferences'
import {
  createGuideSessionModel,
  guideSessionReduce,
  type GuideSessionModel
} from '@presentation/features/beginner-guide/useGuideSession'
import { useWorkbenchSessionStore } from '@presentation/features/workbench-session/workbenchSession.store'
import {
  useSceneGeneration,
  type SceneGenerationController,
  type UseSceneGenerationOptions
} from '@presentation/pages/workbench/drawer/generation/useSceneGeneration'
import type { AppPage } from '@presentation/stores/navigation.store'
import { TEST_SCOPE, fact } from './guideFacts'

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const PROJECT_ID = 'project-1'
const SCENE_ID = 'scene-1'
const CANVAS_ID = 'canvas-1'
const SCOPE = { projectId: PROJECT_ID, sceneId: SCENE_ID, canvasId: CANVAS_ID }

class FakeNavigation implements CreatorNavigation {
  private current: CreatorNavigationSnapshot = { page: 'workbench', projectId: PROJECT_ID }
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

function ok<T>(data: T): AjaxResult<T> {
  return { code: ErrorCodes.success, msg: 'ok', data }
}

function failed(code: number, msg: string): AjaxResult<never> {
  return { code, msg }
}

function statusOf(
  operationId: string,
  overrides: Partial<SceneGenerationRenderStatusVO> = {}
): SceneGenerationRenderStatusVO {
  return {
    projectId: PROJECT_ID,
    sceneId: SCENE_ID,
    operationId,
    threadId: `thread-${operationId}`,
    branchId: `branch-${operationId}`,
    state: 'pending',
    stage: 'readingInput',
    stageMessage: '正在读取已保存编排与输入',
    attempt: 1,
    sequence: 5,
    canPause: true,
    canResume: false,
    canCancel: true,
    inputSummary: {
      canvasId: CANVAS_ID,
      arrangementVersion: 'v1',
      documentCount: 2,
      assetCount: 6,
      promptCount: 1,
      fieldBindingCount: 3,
      relationCount: 4,
      confirmedControlCount: 0
    },
    usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30, tokenLimit: null },
    previewAvailable: false,
    ...overrides
  }
}

function reviewInteraction(
  overrides: Partial<SceneGenerationRenderInteractionVO> = {}
): SceneGenerationRenderInteractionVO {
  return {
    interactionId: 'interaction-a',
    checkpointId: 'checkpoint-a',
    kind: 'review',
    message: '请审阅当前候选',
    allowedReplies: ['accept', 'revise', 'discard'],
    options: [],
    candidateSnapshotId: 'candidate-a',
    ...overrides
  } as SceneGenerationRenderInteractionVO
}

function waitingStatus(): SceneGenerationRenderStatusVO {
  return statusOf('operation-a', {
    state: 'waiting',
    stage: 'waitingReview',
    stageMessage: '候选已就绪，等待你的决定',
    checkpointId: 'checkpoint-a',
    candidateSnapshotId: 'candidate-a',
    interaction: reviewInteraction(),
    previewAvailable: true,
    sequence: 8
  })
}

function committedStatus(
  operationId = 'operation-a',
  candidateSnapshotId = 'candidate-a'
): SceneGenerationRenderStatusVO {
  return statusOf(operationId, {
    state: 'succeeded',
    stage: 'completed',
    stageMessage: '作品已提交',
    checkpointId: 'checkpoint-a',
    candidateSnapshotId,
    canPause: false,
    canCancel: false,
    result: { commitId: `commit-${operationId}` },
    sequence: 12
  })
}

function failedRepairStatus(): SceneGenerationRenderStatusVO {
  return statusOf('operation-a', {
    state: 'failed',
    stage: 'failed',
    stageMessage: '本次生成未完成',
    mode: 'repair',
    checkpointId: 'checkpoint-a',
    candidateSnapshotId: 'candidate-a',
    canPause: false,
    canResume: false,
    canCancel: false,
    userMessages: [{ kind: 'revise', body: '把结尾改慢一点', round: 1 }],
    failure: { code: 5103, message: '生成没有完成', unverified: false },
    sequence: 9
  })
}

function historyPageOf(operationId: string): SceneGenerationHistoryPageVO {
  return {
    items: [
      {
        projectId: PROJECT_ID,
        sceneId: SCENE_ID,
        operationId,
        threadId: `thread-${operationId}`,
        branchId: `branch-${operationId}`,
        checkpointId: 'checkpoint-a',
        boundary: 'failed',
        stage: 'failed',
        message: '本次生成未完成',
        createdAt: '2026-11-23T10:00:00.000Z'
      }
    ],
    unfinished: []
  }
}

async function flush(): Promise<void> {
  await act(async () => {
    for (let index = 0; index < 30; index += 1) await Promise.resolve()
  })
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (predicate()) return
    await flush()
  }
  throw new Error('等待条件没有在限定轮次内成立')
}

function startWorkbench(): void {
  useWorkbenchSessionStore.getState().reset()
  useWorkbenchSessionStore.getState().startSession({
    projectId: PROJECT_ID,
    projectName: '雨夜门口',
    sceneId: SCENE_ID,
    canvasId: CANVAS_ID
  })
  useWorkbenchSessionStore.getState().setArrangement({
    projectId: PROJECT_ID,
    sceneId: SCENE_ID,
    canvasId: CANVAS_ID,
    viewport: { x: 0, y: 0, zoom: 1 },
    cards: [],
    relations: []
  })
}

async function mountSceneGeneration(options: UseSceneGenerationOptions): Promise<{
  controller: () => SceneGenerationController
  unmount: () => Promise<void>
}> {
  let current: SceneGenerationController | null = null
  const Probe = (): null => {
    current = useSceneGeneration(options)
    return null
  }
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  await act(async () => {
    root.render(createElement(Probe))
  })
  await flush()
  return {
    controller: () => {
      if (current === null) throw new Error('场景生成 hook 尚未挂载')
      return current
    },
    unmount: async () => {
      await act(async () => {
        root.unmount()
      })
      container.remove()
    }
  }
}

function send(state: GuideSessionState, nextFact: GuideFact): GuideSessionState {
  return advanceGuide(state, { type: 'fact', fact: nextFact }).state
}

function guideAtGenerationWait(): GuideSessionState {
  let state = createGuideState({
    stepId: GUIDE_STEP_ID.saveAndGenerate,
    scope: TEST_SCOPE
  })
  state = send(state, fact<CanvasSavedFact>({ kind: 'canvasSaved', reason: 'manual' }))
  state = send(state, fact<InputSummaryOpenedFact>({ kind: 'inputSummaryOpened' }))
  return state
}

function guideAtFailedGeneration(): GuideSessionState {
  let state = guideAtGenerationWait()
  state = send(
    state,
    fact<GenerationStartedFact>({ kind: 'generationStarted', operationId: 'operation-a' })
  )
  state = send(
    state,
    fact<GenerationFailedFact>({ kind: 'generationFailed', operationId: 'operation-a' })
  )
  return state
}

function guideAtCandidateDecision(): GuideSessionState {
  let state = guideAtGenerationWait()
  state = send(
    state,
    fact<GenerationStartedFact>({ kind: 'generationStarted', operationId: 'operation-a' })
  )
  state = send(
    state,
    fact<CandidateReadyFact>({
      kind: 'candidateReady',
      candidateSnapshotId: 'candidate-a',
      operationId: 'operation-a',
      previewAvailable: true
    })
  )
  state = advanceGuide(state, {
    type: 'candidate-opened',
    candidateSnapshotId: 'candidate-a'
  }).state
  state = advanceGuide(state, {
    type: 'candidate-returned',
    candidateSnapshotId: 'candidate-a'
  }).state
  return state
}

function guideAtRevisionFailure(): GuideSessionState {
  let state = guideAtGenerationWait()
  state = send(
    state,
    fact<GenerationStartedFact>({ kind: 'generationStarted', operationId: 'operation-a' })
  )
  state = send(
    state,
    fact<CandidateReadyFact>({
      kind: 'candidateReady',
      candidateSnapshotId: 'candidate-a',
      operationId: 'operation-a',
      previewAvailable: true
    })
  )
  state = advanceGuide(state, {
    type: 'candidate-opened',
    candidateSnapshotId: 'candidate-a'
  }).state
  state = advanceGuide(state, {
    type: 'candidate-returned',
    candidateSnapshotId: 'candidate-a'
  }).state
  state = advanceGuide(state, {
    type: 'candidate-revised',
    candidateSnapshotId: 'candidate-a'
  }).state
  return state
}

type Observation = CreatorActionObservation

function observeGuide(): {
  observation: Observation
  unsubscribe: () => void
  navigation: FakeNavigation
} {
  startWorkbench()
  const navigation = new FakeNavigation()
  const observation = createCreatorActionObservation({
    navigation,
    now: () => new Date('2026-11-23T10:00:00.000Z')
  })
  const unsubscribe = observation.source.subscribe(() => undefined)
  return { observation, unsubscribe, navigation }
}

function createDeferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  return Promise.withResolvers<T>()
}

function sessionAtGenerationWait(): GuideSessionModel {
  let model = createGuideSessionModel(createDefaultGuidePreferences())
  model = guideSessionReduce(
    model,
    {
      type: 'start-tutorial',
      stepId: GUIDE_STEP_ID.saveAndGenerate,
      scope: TEST_SCOPE
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

function sessionAtFailedGeneration(): GuideSessionModel {
  let model = guideSessionReduce(
    sessionAtGenerationWait(),
    {
      type: 'fact',
      fact: fact<GenerationStartedFact>({
        kind: 'generationStarted',
        operationId: 'operation-a'
      }),
      scope: TEST_SCOPE
    },
    null
  )
  return guideSessionReduce(
    model,
    {
      type: 'fact',
      fact: fact<GenerationFailedFact>({
        kind: 'generationFailed',
        operationId: 'operation-a'
      }),
      scope: TEST_SCOPE
    },
    null
  )
}

function generationOptions(
  observation: Observation,
  client: SceneGenerationClient,
  saveCanvas: () => Promise<{ ok: true }>,
  onAccepted: () => void
): UseSceneGenerationOptions {
  return {
    projectClient: {
      ensureProjectWorkspace: vi.fn(async () => ok({}))
    } as unknown as ProjectClient,
    client,
    projectId: PROJECT_ID,
    sceneId: SCENE_ID,
    canvasId: CANVAS_ID,
    saveState: 'saved',
    pageBlocked: false,
    canvasReady: true,
    saveCanvas,
    onGenerationStarted: ({ operationId }) => {
      observation.workbench.onGenerationStarted?.({
        scope: SCOPE,
        operationId,
        saveVerified: true
      })
    },
    onCandidateAccepted: ({ operationId, candidateSnapshotId }) => {
      observation.workbench.onCandidateAccepted?.({
        scope: SCOPE,
        operationId,
        candidateSnapshotId,
        outcome: 'confirmed'
      })
      onAccepted()
    }
  }
}

const cleanup: Array<() => Promise<void>> = []

afterEach(async () => {
  while (cleanup.length > 0) await cleanup.pop()?.()
  useWorkbenchSessionStore.getState().reset()
})

describe('生成候选结果回流', () => {
  it('真实修复重跑产生 B 后发布启动事实，教程接续 B 并拒绝 A 的迟到候选', async () => {
    const { observation, unsubscribe } = observeGuide()
    let guide = guideAtRevisionFailure()
    const guideFacts: GuideFact[] = []
    const unsubscribeFacts = observation.source.subscribe((nextFact) => {
      guideFacts.push(nextFact)
      guide = send(guide, nextFact)
    })
    cleanup.push(async () => {
      unsubscribeFacts()
      unsubscribe()
    })

    const statuses = new Map<string, SceneGenerationRenderStatusVO>([
      ['operation-a', failedRepairStatus()]
    ])
    const client = {
      listHistory: vi.fn(async () => ok(historyPageOf('operation-a'))),
      status: vi.fn(async (request: { operationId: string }) => {
        const found = statuses.get(request.operationId)
        return found ? ok(found) : failed(ErrorCodes.invalidRequest, '操作不存在')
      }),
      latest: vi.fn(async () => ok(null)),
      start: vi.fn(async () => failed(ErrorCodes.internalError, '测试不配置启动')),
      reply: vi.fn(async () => failed(ErrorCodes.internalError, '测试不配置回复')),
      retryRepair: vi.fn(async () => {
        const next = statusOf('operation-b', {
          state: 'pending',
          stage: 'readingInput',
          stageMessage: '正在读取已保存编排与输入',
          mode: 'repair',
          sequence: 12
        })
        statuses.set('operation-b', next)
        return ok(next)
      }),
      subscribeProgress: vi.fn(() => () => undefined)
    } as unknown as SceneGenerationClient

    const accepted: string[] = []
    const saveCanvas = vi.fn(async () => ({ ok: true as const }))
    const host = await mountSceneGeneration(
      generationOptions(observation, client, saveCanvas, () => accepted.push('accepted'))
    )
    cleanup.push(host.unmount)

    await waitFor(() => host.controller().status?.operationId === 'operation-a')
    await waitFor(() => host.controller().startBlockedReason === null)
    expect(host.controller().status?.state).toBe('failed')

    await act(async () => {
      await host.controller().retryRepair()
    })
    await waitFor(() => host.controller().status?.operationId === 'operation-b')

    expect(saveCanvas).toHaveBeenCalledTimes(1)
    const started = guideFacts.filter(
      (nextFact): nextFact is GenerationStartedFact => nextFact.kind === 'generationStarted'
    )
    expect(started).toHaveLength(1)
    expect(started[0]).toMatchObject({ operationId: 'operation-b' })
    expect(guide.stepId).toBe(GUIDE_STEP_ID.playtestCandidate)
    expect(guide.milestoneIndex).toBe(1)
    expect(guide.generationOperationId).toBe('operation-b')
    expect(guide.candidatePhase).toBe('regenerating')
    expect(guide.activeCandidateSnapshotId).toBeNull()
    expect(guide.supersededCandidateSnapshotId).toBe('candidate-a')
    expect(accepted).toEqual([])

    observation.workbench.onCandidateReady?.({
      scope: SCOPE,
      candidateSnapshotId: 'candidate-a',
      operationId: 'operation-a',
      previewAvailable: true
    })
    expect(guide.stepId).toBe(GUIDE_STEP_ID.playtestCandidate)
    expect(guide.milestoneIndex).toBe(1)
    expect(guide.generationOperationId).toBe('operation-b')
    expect(guide.candidatePhase).toBe('regenerating')
    expect(guide.activeCandidateSnapshotId).toBeNull()

    observation.workbench.onCandidateReady?.({
      scope: SCOPE,
      candidateSnapshotId: 'candidate-b',
      operationId: 'operation-b',
      previewAvailable: true
    })
    expect(guide.stepId).toBe(GUIDE_STEP_ID.playtestCandidate)
    expect(guide.milestoneIndex).toBe(1)
    expect(guide.activeCandidateSnapshotId).toBe('candidate-b')
    expect(guide.candidatePhase).toBe('ready')
    expect(guide.candidateReplay).toBe(true)
    expect(guideFacts.filter((nextFact) => nextFact.kind === 'candidateAccepted')).toEqual([])
  }, 20_000)

  it('修复重跑失败不发布启动事实，教程留在原失败等待', async () => {
    const { observation, unsubscribe } = observeGuide()
    let guide = guideAtFailedGeneration()
    const guideFacts: GuideFact[] = []
    const unsubscribeFacts = observation.source.subscribe((nextFact) => {
      guideFacts.push(nextFact)
      guide = send(guide, nextFact)
    })
    cleanup.push(async () => {
      unsubscribeFacts()
      unsubscribe()
    })

    const client = {
      listHistory: vi.fn(async () => ok(historyPageOf('operation-a'))),
      status: vi.fn(async () => ok(failedRepairStatus())),
      latest: vi.fn(async () => ok(null)),
      start: vi.fn(async () => failed(ErrorCodes.internalError, '测试不配置启动')),
      reply: vi.fn(async () => failed(ErrorCodes.internalError, '测试不配置回复')),
      retryRepair: vi.fn(async () => failed(ErrorCodes.communicationFailed, '修复重跑未确认')),
      subscribeProgress: vi.fn(() => () => undefined)
    } as unknown as SceneGenerationClient

    const host = await mountSceneGeneration(
      generationOptions(observation, client, async () => ({ ok: true as const }), () => undefined)
    )
    cleanup.push(host.unmount)

    await waitFor(() => host.controller().status?.operationId === 'operation-a')
    await waitFor(() => host.controller().startBlockedReason === null)
    await act(async () => {
      await host.controller().retryRepair()
    })
    await flush()

    expect(guideFacts).toEqual([])
    expect(guide.stepId).toBe(GUIDE_STEP_ID.saveAndGenerate)
    expect(guide.milestoneIndex).toBe(2)
    expect(guide.generationOperationId).toBeNull()
    expect(guide.generationRunState).toBe('failed')
  }, 20_000)

  it('接受回复只写待执行时不进入第 7 步，正式提交成功后才发布接受', async () => {
    const { observation, unsubscribe } = observeGuide()
    let guide = guideAtCandidateDecision()
    const guideFacts: GuideFact[] = []
    const unsubscribeFacts = observation.source.subscribe((nextFact) => {
      guideFacts.push(nextFact)
      guide = send(guide, nextFact)
    })
    cleanup.push(async () => {
      unsubscribeFacts()
      unsubscribe()
    })

    let progressListener: ((event: SceneGenerationRenderProgressEventVO) => void) | null = null
    const client = {
      listHistory: vi.fn(async () =>
        ok({
          items: [
            {
              projectId: PROJECT_ID,
              sceneId: SCENE_ID,
              operationId: 'operation-a',
              threadId: 'thread-operation-a',
              branchId: 'branch-operation-a',
              checkpointId: 'checkpoint-a',
              boundary: 'waitingReview',
              stage: 'waitingReview',
              message: '候选已就绪',
              createdAt: '2026-11-23T10:00:00.000Z',
              candidateSnapshotId: 'candidate-a'
            }
          ],
          unfinished: []
        } satisfies SceneGenerationHistoryPageVO)
      ),
      status: vi.fn(async () => ok(waitingStatus())),
      latest: vi.fn(async () => ok(null)),
      start: vi.fn(async () => failed(ErrorCodes.internalError, '测试不配置启动')),
      reply: vi.fn(async () =>
        ok(
          statusOf('operation-a', {
            state: 'pending',
            stage: 'committing',
            stageMessage: '正在提交作品',
            checkpointId: 'checkpoint-a',
            candidateSnapshotId: 'candidate-a',
            interaction: reviewInteraction(),
            previewAvailable: true,
            canPause: false,
            canCancel: false,
            sequence: 9
          })
        )
      ),
      retryRepair: vi.fn(async () => failed(ErrorCodes.internalError, '测试不配置修复重跑')),
      subscribeProgress: vi.fn((_scope, listener) => {
        progressListener = listener
        return () => undefined
      })
    } as unknown as SceneGenerationClient

    const accepted: string[] = []
    const host = await mountSceneGeneration(
      generationOptions(observation, client, async () => ({ ok: true as const }), () =>
        accepted.push('accepted')
      )
    )
    cleanup.push(host.unmount)

    await waitFor(() => host.controller().status?.state === 'waiting')
    expect(host.controller().status?.candidateSnapshotId).toBe('candidate-a')

    await act(async () => {
      await host.controller().accept()
    })
    await flush()

    expect(guideFacts).toEqual([])
    expect(accepted).toEqual([])
    expect(guide.stepId).toBe(GUIDE_STEP_ID.playtestCandidate)
    expect(guide.milestoneIndex).toBe(1)
    expect(guide.candidatePhase).toBe('returned')

    const succeeded = statusOf('operation-a', {
      state: 'succeeded',
      stage: 'completed',
      stageMessage: '作品已提交',
      checkpointId: 'checkpoint-a',
      candidateSnapshotId: 'candidate-a',
      canPause: false,
      canCancel: false,
      result: { commitId: 'commit-a' },
      sequence: 12
    })
    await act(async () => {
      progressListener?.({ ...succeeded, message: succeeded.stageMessage })
    })
    await waitFor(() => accepted.length === 1)

    expect(guideFacts.map((nextFact) => nextFact.kind)).toEqual(['candidateAccepted'])
    expect(guideFacts[0]).toMatchObject({
      kind: 'candidateAccepted',
      candidateSnapshotId: 'candidate-a',
      outcome: 'confirmed'
    })
    expect(guide.stepId).toBe(GUIDE_STEP_ID.polishDialogue)
    expect(guide.milestoneIndex).toBe(0)
  }, 20_000)

  it('接受回复后的正式提交失败，不发布接受，教程不前进', async () => {
    const { observation, unsubscribe } = observeGuide()
    let guide = guideAtCandidateDecision()
    const guideFacts: GuideFact[] = []
    const unsubscribeFacts = observation.source.subscribe((nextFact) => {
      guideFacts.push(nextFact)
      guide = send(guide, nextFact)
    })
    cleanup.push(async () => {
      unsubscribeFacts()
      unsubscribe()
    })

    let progressListener: ((event: SceneGenerationRenderProgressEventVO) => void) | null = null
    const client = {
      listHistory: vi.fn(async () =>
        ok({
          items: [
            {
              projectId: PROJECT_ID,
              sceneId: SCENE_ID,
              operationId: 'operation-a',
              threadId: 'thread-operation-a',
              branchId: 'branch-operation-a',
              checkpointId: 'checkpoint-a',
              boundary: 'waitingReview',
              stage: 'waitingReview',
              message: '候选已就绪',
              createdAt: '2026-11-23T10:00:00.000Z',
              candidateSnapshotId: 'candidate-a'
            }
          ],
          unfinished: []
        } satisfies SceneGenerationHistoryPageVO)
      ),
      status: vi.fn(async () => ok(waitingStatus())),
      latest: vi.fn(async () => ok(null)),
      start: vi.fn(async () => failed(ErrorCodes.internalError, '测试不配置启动')),
      reply: vi.fn(async () =>
        ok(
          statusOf('operation-a', {
            state: 'pending',
            stage: 'committing',
            stageMessage: '正在提交作品',
            checkpointId: 'checkpoint-a',
            candidateSnapshotId: 'candidate-a',
            interaction: reviewInteraction(),
            previewAvailable: true,
            canPause: false,
            canCancel: false,
            sequence: 9
          })
        )
      ),
      retryRepair: vi.fn(async () => failed(ErrorCodes.internalError, '测试不配置修复重跑')),
      subscribeProgress: vi.fn((_scope, listener) => {
        progressListener = listener
        return () => undefined
      })
    } as unknown as SceneGenerationClient

    const accepted: string[] = []
    const host = await mountSceneGeneration(
      generationOptions(observation, client, async () => ({ ok: true as const }), () =>
        accepted.push('accepted')
      )
    )
    cleanup.push(host.unmount)

    await waitFor(() => host.controller().status?.state === 'waiting')
    await act(async () => {
      await host.controller().accept()
    })
    await flush()
    expect(guideFacts).toEqual([])

    const failedCommit = statusOf('operation-a', {
      state: 'failed',
      stage: 'failed',
      stageMessage: '本次生成未完成',
      checkpointId: 'checkpoint-a',
      candidateSnapshotId: 'candidate-a',
      canPause: false,
      canCancel: false,
      failure: { code: 5103, message: '提交没有完成', unverified: false },
      sequence: 12
    })
    await act(async () => {
      progressListener?.({ ...failedCommit, message: failedCommit.stageMessage })
    })
    await flush()

    expect(accepted).toEqual([])
    expect(guideFacts).toEqual([])
    expect(guide.stepId).toBe(GUIDE_STEP_ID.playtestCandidate)
    expect(guide.milestoneIndex).toBe(1)
    expect(guide.candidatePhase).toBe('returned')
  }, 20_000)

  it('工作台卸载期间正式提交，重挂载后按同一操作和候选结算接受', async () => {
    const { observation, unsubscribe } = observeGuide()
    let guide = guideAtCandidateDecision()
    const guideFacts: GuideFact[] = []
    const unsubscribeFacts = observation.source.subscribe((nextFact) => {
      guideFacts.push(nextFact)
      guide = send(guide, nextFact)
    })
    cleanup.push(async () => {
      unsubscribeFacts()
      unsubscribe()
    })

    let currentStatus = waitingStatus()
    const client = {
      listHistory: vi.fn(async () => ok(historyPageOf('operation-a'))),
      status: vi.fn(async () => ok(currentStatus)),
      latest: vi.fn(async () => ok(null)),
      start: vi.fn(async () => failed(ErrorCodes.internalError, '测试不配置启动')),
      reply: vi.fn(async () =>
        ok(
          statusOf('operation-a', {
            state: 'pending',
            stage: 'committing',
            stageMessage: '正在提交作品',
            checkpointId: 'checkpoint-a',
            candidateSnapshotId: 'candidate-a',
            interaction: reviewInteraction(),
            previewAvailable: true,
            canPause: false,
            canCancel: false,
            sequence: 9
          })
        )
      ),
      retryRepair: vi.fn(async () => failed(ErrorCodes.internalError, '测试不配置修复重跑')),
      subscribeProgress: vi.fn(() => () => undefined)
    } as unknown as SceneGenerationClient

    let firstMounted = true
    const first = await mountSceneGeneration(
      generationOptions(observation, client, async () => ({ ok: true as const }), () => undefined)
    )
    cleanup.push(async () => {
      if (firstMounted) await first.unmount()
    })
    await waitFor(() => first.controller().status?.state === 'waiting')
    await act(async () => {
      await first.controller().accept()
    })
    await flush()
    expect(guideFacts).toEqual([])
    await first.unmount()
    firstMounted = false

    currentStatus = committedStatus()
    const second = await mountSceneGeneration(
      generationOptions(observation, client, async () => ({ ok: true as const }), () => undefined)
    )
    cleanup.push(second.unmount)
    await waitFor(() => second.controller().status?.state === 'succeeded')
    await waitFor(() => guideFacts.length === 1)

    expect(guideFacts[0]).toMatchObject({
      kind: 'candidateAccepted',
      operationId: 'operation-a',
      candidateSnapshotId: 'candidate-a',
      outcome: 'confirmed'
    })
    expect(guide.stepId).toBe(GUIDE_STEP_ID.polishDialogue)
    expect(guide.milestoneIndex).toBe(0)
  }, 20_000)

  it('接受回执未确认时，重复的正式提交通知只结算一次', async () => {
    const { observation, unsubscribe } = observeGuide()
    let guide = guideAtCandidateDecision()
    const guideFacts: GuideFact[] = []
    const unsubscribeFacts = observation.source.subscribe((nextFact) => {
      guideFacts.push(nextFact)
      guide = send(guide, nextFact)
    })
    cleanup.push(async () => {
      unsubscribeFacts()
      unsubscribe()
    })

    let progressListener: ((event: SceneGenerationRenderProgressEventVO) => void) | null = null
    const client = {
      listHistory: vi.fn(async () => ok(historyPageOf('operation-a'))),
      status: vi.fn(async () => ok(waitingStatus())),
      latest: vi.fn(async () => ok(null)),
      start: vi.fn(async () => failed(ErrorCodes.internalError, '测试不配置启动')),
      reply: vi.fn(async () => failed(ErrorCodes.communicationFailed, '回复结果未确认')),
      retryRepair: vi.fn(async () => failed(ErrorCodes.internalError, '测试不配置修复重跑')),
      subscribeProgress: vi.fn((_scope, listener) => {
        progressListener = listener
        return () => undefined
      })
    } as unknown as SceneGenerationClient

    const host = await mountSceneGeneration(
      generationOptions(observation, client, async () => ({ ok: true as const }), () => undefined)
    )
    cleanup.push(host.unmount)
    await waitFor(() => host.controller().status?.state === 'waiting')
    await act(async () => {
      await host.controller().accept()
    })
    await flush()
    expect(guideFacts).toEqual([])

    const succeeded = committedStatus()
    await act(async () => {
      progressListener?.({ ...succeeded, message: succeeded.stageMessage })
    })
    await waitFor(() => guideFacts.length === 1)
    await act(async () => {
      progressListener?.({ ...succeeded, message: succeeded.stageMessage })
    })
    await flush()

    expect(guideFacts).toHaveLength(1)
    expect(guideFacts[0]).toMatchObject({
      kind: 'candidateAccepted',
      operationId: 'operation-a',
      candidateSnapshotId: 'candidate-a'
    })
    expect(guide.stepId).toBe(GUIDE_STEP_ID.polishDialogue)
  }, 20_000)

  it('其他操作的正式提交不推进当前第 6 步', async () => {
    const { observation, unsubscribe } = observeGuide()
    let guide = guideAtCandidateDecision()
    const guideFacts: GuideFact[] = []
    const unsubscribeFacts = observation.source.subscribe((nextFact) => {
      guideFacts.push(nextFact)
      guide = send(guide, nextFact)
    })
    cleanup.push(async () => {
      unsubscribeFacts()
      unsubscribe()
    })

    const client = {
      listHistory: vi.fn(async () => ok(historyPageOf('operation-b'))),
      status: vi.fn(async () => ok(committedStatus('operation-b', 'candidate-a'))),
      latest: vi.fn(async () => ok(null)),
      start: vi.fn(async () => failed(ErrorCodes.internalError, '测试不配置启动')),
      reply: vi.fn(async () => failed(ErrorCodes.internalError, '测试不配置回复')),
      retryRepair: vi.fn(async () => failed(ErrorCodes.internalError, '测试不配置修复重跑')),
      subscribeProgress: vi.fn(() => () => undefined)
    } as unknown as SceneGenerationClient

    const host = await mountSceneGeneration(
      generationOptions(observation, client, async () => ({ ok: true as const }), () => undefined)
    )
    cleanup.push(host.unmount)
    await waitFor(() => host.controller().status?.state === 'succeeded')
    await waitFor(() => guideFacts.length === 1)

    expect(guideFacts[0]).toMatchObject({
      kind: 'candidateAccepted',
      operationId: 'operation-b',
      candidateSnapshotId: 'candidate-a'
    })
    expect(guide.stepId).toBe(GUIDE_STEP_ID.playtestCandidate)
    expect(guide.milestoneIndex).toBe(1)
    expect(guide.candidatePhase).toBe('returned')
  }, 20_000)

  it('启动响应在工作台卸载后才到达时，恢复后仍认领本次操作并拒绝无关历史', async () => {
    const { observation, unsubscribe, navigation } = observeGuide()
    let session = sessionAtGenerationWait()
    const guideFacts: GuideFact[] = []
    const unsubscribeFacts = observation.source.subscribe((nextFact) => {
      guideFacts.push(nextFact)
      session = guideSessionReduce(
        session,
        { type: 'fact', fact: nextFact },
        null
      )
    })
    cleanup.push(async () => {
      unsubscribeFacts()
      unsubscribe()
    })

    const deferred = Promise.withResolvers<AjaxResult<SceneGenerationRenderStatusVO>>()
    const start = vi.fn(() => deferred.promise)
    const client = {
      listHistory: vi.fn(async () => ok({ items: [], unfinished: [] } satisfies SceneGenerationHistoryPageVO)),
      status: vi.fn(async () => ok(waitingStatus())),
      latest: vi.fn(async () => ok(null)),
      start,
      reply: vi.fn(async () => failed(ErrorCodes.internalError, '测试不配置回复')),
      retryRepair: vi.fn(async () => failed(ErrorCodes.internalError, '测试不配置修复重跑')),
      subscribeProgress: vi.fn(() => () => undefined)
    } as unknown as SceneGenerationClient

    let mounted = true
    const host = await mountSceneGeneration(
      generationOptions(observation, client, async () => ({ ok: true as const }), () => undefined)
    )
    cleanup.push(async () => {
      if (mounted) await host.unmount()
    })
    await waitFor(() => host.controller().loading === false)
    await waitFor(() => host.controller().startBlockedReason === null)

    let startPromise: Promise<void> | null = null
    await act(async () => {
      startPromise = host.controller().start()
    })
    await waitFor(() => start.mock.calls.length === 1)

    navigation.visit('projects', null)
    session = guideSessionReduce(
      session,
      {
        type: 'sync-context',
        scope: { projectId: null, sceneId: null, canvasId: null },
        page: 'project-list'
      },
      null
    )
    expect(session.guide?.status).toBe('paused')
    await host.unmount()
    mounted = false

    await act(async () => {
      deferred.resolve(
        ok(
          statusOf('operation-new', {
            state: 'pending',
            stage: 'readingInput',
            stageMessage: '正在读取已保存编排与输入',
            sequence: 7
          })
        )
      )
      await startPromise
    })
    await flush()

    expect(guideFacts.map((nextFact) => nextFact.kind)).toContain('generationStarted')
    expect(session.pausedFacts.map((entry) => entry.fact.kind)).toContain('generationStarted')

    navigation.visit('workbench', PROJECT_ID)
    const waitingNew = statusOf('operation-new', {
      state: 'waiting',
      stage: 'waitingReview',
      stageMessage: '候选已就绪，等待你的决定',
      checkpointId: 'checkpoint-a',
      candidateSnapshotId: 'candidate-new',
      interaction: reviewInteraction({ candidateSnapshotId: 'candidate-new' }),
      previewAvailable: true,
      sequence: 9
    })
    const remountClient = {
      listHistory: vi.fn(async () => ok(historyPageOf('operation-new'))),
      status: vi.fn(async () => ok(waitingNew)),
      latest: vi.fn(async () => ok(null)),
      start: vi.fn(async () => failed(ErrorCodes.internalError, '测试不配置启动')),
      reply: vi.fn(async () => failed(ErrorCodes.internalError, '测试不配置回复')),
      retryRepair: vi.fn(async () => failed(ErrorCodes.internalError, '测试不配置修复重跑')),
      subscribeProgress: vi.fn(() => () => undefined)
    } as unknown as SceneGenerationClient
    const remounted = await mountSceneGeneration(
      generationOptions(observation, remountClient, async () => ({ ok: true as const }), () => undefined)
    )
    cleanup.push(remounted.unmount)
    await waitFor(() => remounted.controller().status?.state === 'waiting')

    observation.workbench.onCandidateReady?.({
      scope: SCOPE,
      candidateSnapshotId: 'candidate-new',
      operationId: 'operation-new',
      previewAvailable: true
    })
    expect(session.guide?.status).toBe('paused')
    expect(session.pausedFacts.map((entry) => entry.fact.kind)).toContain('candidateReady')

    session = guideSessionReduce(session, { type: 'resume', scope: TEST_SCOPE }, null)
    expect(session.guide?.stepId).toBe(GUIDE_STEP_ID.playtestCandidate)
    expect(session.guide?.activeCandidateSnapshotId).toBe('candidate-new')

    observation.workbench.onCandidateReady?.({
      scope: SCOPE,
      candidateSnapshotId: 'candidate-old',
      operationId: 'operation-old',
      previewAvailable: true
    })
    expect(session.guide?.stepId).toBe(GUIDE_STEP_ID.playtestCandidate)
    expect(session.guide?.activeCandidateSnapshotId).toBe('candidate-new')
  }, 20_000)

  it('修复重跑响应在工作台卸载后才到达时，恢复后仍认领新操作并拒绝旧历史', async () => {
    const { observation, unsubscribe, navigation } = observeGuide()
    let session = sessionAtFailedGeneration()
    const guideFacts: GuideFact[] = []
    const unsubscribeFacts = observation.source.subscribe((nextFact) => {
      guideFacts.push(nextFact)
      session = guideSessionReduce(
        session,
        { type: 'fact', fact: nextFact },
        null
      )
    })
    cleanup.push(async () => {
      unsubscribeFacts()
      unsubscribe()
    })

    const deferred = Promise.withResolvers<AjaxResult<SceneGenerationRenderStatusVO>>()
    const retry = vi.fn(() => deferred.promise)
    const client = {
      listHistory: vi.fn(async () => ok(historyPageOf('operation-a'))),
      status: vi.fn(async () => ok(failedRepairStatus())),
      latest: vi.fn(async () => ok(null)),
      start: vi.fn(async () => failed(ErrorCodes.internalError, '测试不配置启动')),
      reply: vi.fn(async () => failed(ErrorCodes.internalError, '测试不配置回复')),
      retryRepair: retry,
      subscribeProgress: vi.fn(() => () => undefined)
    } as unknown as SceneGenerationClient

    let mounted = true
    const host = await mountSceneGeneration(
      generationOptions(observation, client, async () => ({ ok: true as const }), () => undefined)
    )
    cleanup.push(async () => {
      if (mounted) await host.unmount()
    })
    await waitFor(() => host.controller().status?.state === 'failed')
    await waitFor(() => host.controller().repairBlockedReason === null)

    let retryPromise: Promise<void> | null = null
    await act(async () => {
      retryPromise = host.controller().retryRepair()
    })
    await waitFor(() => retry.mock.calls.length === 1)

    navigation.visit('projects', null)
    session = guideSessionReduce(
      session,
      {
        type: 'sync-context',
        scope: { projectId: null, sceneId: null, canvasId: null },
        page: 'project-list'
      },
      null
    )
    expect(session.guide?.status).toBe('paused')
    await host.unmount()
    mounted = false

    await act(async () => {
      deferred.resolve(
        ok(
          statusOf('operation-new', {
            state: 'pending',
            stage: 'readingInput',
            stageMessage: '正在读取已保存编排与输入',
            sequence: 7
          })
        )
      )
      await retryPromise
    })
    await flush()

    expect(guideFacts.map((nextFact) => nextFact.kind)).toContain('generationStarted')
    session = guideSessionReduce(session, { type: 'resume', scope: TEST_SCOPE }, null)
    expect(session.guide?.generationOperationId).toBe('operation-new')
    expect(session.guide?.generationRunState).toBe('running')

    navigation.visit('workbench', PROJECT_ID)
    observation.workbench.onCandidateReady?.({
      scope: SCOPE,
      candidateSnapshotId: 'candidate-old',
      operationId: 'operation-old',
      previewAvailable: true
    })
    expect(session.guide?.stepId).toBe(GUIDE_STEP_ID.saveAndGenerate)
    expect(session.guide?.activeCandidateSnapshotId).toBeNull()

    observation.workbench.onCandidateReady?.({
      scope: SCOPE,
      candidateSnapshotId: 'candidate-new',
      operationId: 'operation-new',
      previewAvailable: true
    })
    expect(session.guide?.stepId).toBe(GUIDE_STEP_ID.playtestCandidate)
    expect(session.guide?.activeCandidateSnapshotId).toBe('candidate-new')
  }, 20_000)
})
