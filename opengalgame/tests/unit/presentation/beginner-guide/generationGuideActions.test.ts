import { afterEach, describe, expect, it } from 'vitest'

import type {
  SceneGenerationRenderInteractionVO,
  SceneGenerationRenderStatusVO
} from '@application/scene-generation/vo/SceneGenerationRenderVO'
import {
  createCreatorActionObservation,
  type CreatorNavigation,
  type CreatorNavigationSnapshot
} from '@presentation/app/observeCreatorActions'
import type { GuideFact } from '@presentation/features/beginner-guide/guideObservation'
import { canAccept } from '@presentation/pages/workbench/drawer/generation/generationPresentation'
import { useWorkbenchSessionStore } from '@presentation/features/workbench-session/workbenchSession.store'
import type { AppPage } from '@presentation/stores/navigation.store'

const SCOPE = { projectId: 'p-01', sceneId: 'scene-1', canvasId: 'canvas-1' }

class FakeNavigation implements CreatorNavigation {
  private current: CreatorNavigationSnapshot = { page: 'workbench', projectId: 'p-01' }
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

function startWorkbench(): void {
  useWorkbenchSessionStore.getState().reset()
  useWorkbenchSessionStore.getState().startSession({
    projectId: 'p-01',
    projectName: '未寄出的第二封信',
    sceneId: 'scene-1',
    canvasId: 'canvas-1'
  })
  useWorkbenchSessionStore.getState().setArrangement({
    projectId: 'p-01',
    sceneId: 'scene-1',
    canvasId: 'canvas-1',
    viewport: { x: 0, y: 0, zoom: 1 },
    cards: [],
    relations: []
  })
}

function setup(): {
  navigation: FakeNavigation
  observation: ReturnType<typeof createCreatorActionObservation>
  facts: GuideFact[]
} {
  startWorkbench()
  const navigation = new FakeNavigation()
  const observation = createCreatorActionObservation({
    navigation,
    now: () => new Date('2026-11-22T10:00:00.000Z')
  })
  const facts: GuideFact[] = []
  observation.source.subscribe((fact) => facts.push(fact))
  return { navigation, observation, facts }
}

function reviewInteraction(
  overrides: Partial<SceneGenerationRenderInteractionVO> = {}
): SceneGenerationRenderInteractionVO {
  return {
    interactionId: 'interaction-1',
    checkpointId: 'checkpoint-1',
    kind: 'review',
    message: '请审阅当前候选',
    allowedReplies: ['accept', 'revise', 'discard'],
    options: [],
    ...overrides
  } as SceneGenerationRenderInteractionVO
}

function reviewStatus(
  overrides: Partial<SceneGenerationRenderStatusVO> = {}
): SceneGenerationRenderStatusVO {
  return {
    projectId: 'p-01',
    sceneId: 'scene-1',
    operationId: 'op-1',
    threadId: 'thread-1',
    branchId: 'branch-1',
    state: 'waiting',
    stage: 'waitingReview',
    sequence: 1,
    previewAvailable: true,
    knownIssues: [],
    ...overrides
  } as SceneGenerationRenderStatusVO
}

afterEach(() => {
  useWorkbenchSessionStore.getState().reset()
})

describe('生成事实映射', () => {
  it('开始生成成功后只发一次，保存已确认', () => {
    const { observation, facts } = setup()

    observation.workbench.onGenerationStarted?.({
      scope: SCOPE,
      operationId: 'op-1',
      saveVerified: true
    })
    observation.workbench.onGenerationStarted?.({
      scope: SCOPE,
      operationId: 'op-1',
      saveVerified: true
    })

    expect(facts).toHaveLength(1)
    expect(facts[0]).toMatchObject({
      kind: 'generationStarted',
      operationId: 'op-1',
      saveVerified: true,
      outcome: 'confirmed',
      scope: SCOPE
    })
  })

  it('旧工程/旧场景的启动事实保留发起 scope，归属由会话判断', () => {
    const { observation, facts } = setup()

    observation.workbench.onGenerationStarted?.({
      scope: { ...SCOPE, projectId: 'p-02' },
      operationId: 'op-old',
      saveVerified: true
    })
    observation.workbench.onGenerationStarted?.({
      scope: { ...SCOPE, sceneId: 'scene-old' },
      operationId: 'op-old',
      saveVerified: true
    })

    expect(facts).toHaveLength(2)
    expect(facts[0]).toMatchObject({
      kind: 'generationStarted',
      operationId: 'op-old',
      scope: { ...SCOPE, projectId: 'p-02' }
    })
    expect(facts[1]).toMatchObject({
      kind: 'generationStarted',
      operationId: 'op-old',
      scope: { ...SCOPE, sceneId: 'scene-old' }
    })
  })

  it('生成失败同一操作只发一次，不同场景各自保留 scope', () => {
    const { observation, facts } = setup()

    observation.workbench.onGenerationFailed?.({
      scope: SCOPE,
      operationId: 'op-1',
      outcome: 'confirmed'
    })
    observation.workbench.onGenerationFailed?.({
      scope: SCOPE,
      operationId: 'op-1',
      outcome: 'confirmed'
    })
    observation.workbench.onGenerationFailed?.({
      scope: { ...SCOPE, sceneId: 'scene-old' },
      operationId: 'op-old',
      outcome: 'confirmed'
    })

    expect(facts).toHaveLength(2)
    expect(facts[0]).toMatchObject({
      kind: 'generationFailed',
      operationId: 'op-1',
      outcome: 'confirmed',
      scope: SCOPE
    })
    expect(facts[1]).toMatchObject({
      kind: 'generationFailed',
      operationId: 'op-old',
      outcome: 'confirmed',
      scope: { ...SCOPE, sceneId: 'scene-old' }
    })
  })
})

describe('候选事实映射', () => {
  it('候选就绪只在预览可用时发一次', () => {
    const { observation, facts } = setup()

    for (let index = 0; index < 2; index += 1) {
      observation.workbench.onCandidateReady?.({
        scope: SCOPE,
        candidateSnapshotId: 'cand-1',
        operationId: 'op-1',
        previewAvailable: true
      })
    }

    expect(facts).toHaveLength(1)
    expect(facts[0]).toMatchObject({
      kind: 'candidateReady',
      candidateSnapshotId: 'cand-1',
      operationId: 'op-1',
      previewAvailable: true,
      scope: SCOPE
    })
  })

  it('同一候选可以反复打开和返回，接受/修订/丢弃仍去重', () => {
    const { observation, facts } = setup()

    observation.workbench.onCandidateOpened?.({ scope: SCOPE, candidateSnapshotId: 'cand-1' })
    observation.workbench.onCandidateReturned?.({ scope: SCOPE, candidateSnapshotId: 'cand-1' })
    observation.workbench.onCandidateOpened?.({ scope: SCOPE, candidateSnapshotId: 'cand-1' })
    observation.workbench.onCandidateReturned?.({ scope: SCOPE, candidateSnapshotId: 'cand-1' })
    observation.workbench.onCandidateAccepted?.({
      scope: SCOPE,
      operationId: 'op-1',
      candidateSnapshotId: 'cand-1',
      outcome: 'confirmed'
    })
    observation.workbench.onCandidateAccepted?.({
      scope: SCOPE,
      operationId: 'op-1',
      candidateSnapshotId: 'cand-1',
      outcome: 'confirmed'
    })
    observation.workbench.onCandidateRevised?.({
      scope: SCOPE,
      candidateSnapshotId: 'cand-1',
      operationId: 'op-1'
    })
    observation.workbench.onCandidateRevised?.({
      scope: SCOPE,
      candidateSnapshotId: 'cand-1',
      operationId: 'op-1'
    })
    observation.workbench.onCandidateDiscarded?.({
      scope: SCOPE,
      candidateSnapshotId: 'cand-1',
      outcome: 'confirmed'
    })
    observation.workbench.onCandidateDiscarded?.({
      scope: SCOPE,
      candidateSnapshotId: 'cand-1',
      outcome: 'confirmed'
    })

    expect(facts.map((fact) => fact.kind)).toEqual([
      'candidateOpened',
      'candidateReturned',
      'candidateOpened',
      'candidateReturned',
      'candidateAccepted',
      'candidateRevised',
      'candidateDiscarded'
    ])
    expect(facts[5]).toMatchObject({ candidateSnapshotId: 'cand-1', operationId: 'op-1' })
  })

  it('接受/丢弃只接受 confirmed 结果', () => {
    const { observation, facts } = setup()

    observation.workbench.onCandidateAccepted?.({
      scope: SCOPE,
      candidateSnapshotId: 'cand-1',
      outcome: 'failed'
    } as unknown as Parameters<NonNullable<typeof observation.workbench.onCandidateAccepted>>[0])
    observation.workbench.onCandidateDiscarded?.({
      scope: SCOPE,
      candidateSnapshotId: 'cand-1',
      outcome: 'unverified'
    } as unknown as Parameters<NonNullable<typeof observation.workbench.onCandidateDiscarded>>[0])

    expect(facts).toHaveLength(0)
  })

  it('切换工程后迟到的候选事实保留发起 scope，归属由会话判断', () => {
    const { navigation, observation, facts } = setup()

    navigation.visit('projects', null)
    observation.workbench.onCandidateOpened?.({ scope: SCOPE, candidateSnapshotId: 'cand-1' })
    observation.workbench.onCandidateAccepted?.({
      scope: SCOPE,
      operationId: 'op-1',
      candidateSnapshotId: 'cand-1',
      outcome: 'confirmed'
    })

    expect(facts.map((nextFact) => nextFact.kind)).toEqual([
      'candidateOpened',
      'candidateAccepted'
    ])
    expect(facts[0]).toMatchObject({ scope: SCOPE, candidateSnapshotId: 'cand-1' })
    expect(facts[1]).toMatchObject({
      scope: SCOPE,
      operationId: 'op-1',
      candidateSnapshotId: 'cand-1'
    })
  })

  it('离开工作台后启动与候选事实都按发起 scope 发布', () => {
    const { navigation, observation, facts } = setup()

    navigation.visit('projects', null)
    observation.workbench.onGenerationStarted?.({
      scope: SCOPE,
      operationId: 'op-started',
      saveVerified: true
    })
    observation.workbench.onCandidateReady?.({
      scope: SCOPE,
      candidateSnapshotId: 'cand-started',
      operationId: 'op-started',
      previewAvailable: true
    })

    expect(facts.map((nextFact) => nextFact.kind)).toEqual([
      'generationStarted',
      'candidateReady'
    ])
    expect(facts[0]).toMatchObject({
      kind: 'generationStarted',
      operationId: 'op-started',
      scope: SCOPE
    })
    expect(facts[1]).toMatchObject({
      kind: 'candidateReady',
      operationId: 'op-started',
      candidateSnapshotId: 'cand-started',
      scope: SCOPE
    })
  })
})

describe('候选接受门', () => {
  it('完成说明缺失（degraded）时不能接受', () => {
    const status = reviewStatus({ candidateSnapshotId: 'cand-1' })
    const interaction = reviewInteraction({
      message: '完成摘要未生成，请核对创作取舍',
      candidateSnapshotId: 'cand-1'
    })

    expect(canAccept(status, interaction)).toBe(false)
  })

  it('自动修正已用尽且仍有可修正问题时不能接受', () => {
    const status = reviewStatus({
      previewAvailable: false,
      knownIssues: [
        {
          code: 'unknown-reference',
          message: '有未知引用',
          correctable: true,
          requiresHumanDecision: false
        }
      ]
    })
    const interaction = reviewInteraction({ candidateSnapshotId: 'cand-1' })

    expect(canAccept(status, interaction)).toBe(false)
  })

  it('正常审阅且允许接受时可以接受', () => {
    const status = reviewStatus({ candidateSnapshotId: 'cand-1' })
    const interaction = reviewInteraction({ candidateSnapshotId: 'cand-1' })

    expect(canAccept(status, interaction)).toBe(true)
  })
})

describe('预览保存与导出事实映射', () => {
  it('同一 requestId 的保存只发一次，旧场景不发', () => {
    const { observation, facts } = setup()

    observation.workbench.onDialogueSaved?.({
      scope: SCOPE,
      requestId: 'request-1',
      revision: 1,
      outcome: 'confirmed'
    })
    observation.workbench.onDialogueSaved?.({
      scope: SCOPE,
      requestId: 'request-1',
      revision: 2,
      outcome: 'confirmed'
    })
    observation.workbench.onDialogueSaved?.({
      scope: { ...SCOPE, sceneId: 'scene-old' },
      requestId: 'request-old',
      revision: 1,
      outcome: 'confirmed'
    })

    expect(facts).toHaveLength(1)
    expect(facts[0]).toMatchObject({
      kind: 'dialogueSaved',
      requestId: 'request-1',
      revision: 1,
      outcome: 'confirmed'
    })
  })

  it('保存失败或待核对只发 unsettled 事实，旧场景不发', () => {
    const { observation, facts } = setup()

    observation.workbench.onDialogueSaveUnsettled?.({
      scope: SCOPE,
      requestId: 'request-1',
      outcome: 'unverified'
    })
    observation.workbench.onDialogueSaveUnsettled?.({
      scope: { ...SCOPE, sceneId: 'scene-old' },
      requestId: 'request-old',
      outcome: 'failed'
    })
    observation.workbench.onDialogueSaveUnsettled?.({
      scope: SCOPE,
      requestId: 'request-1',
      outcome: 'failed'
    })

    expect(facts).toHaveLength(2)
    expect(facts[0]).toMatchObject({
      kind: 'dialogueSaveUnsettled',
      requestId: 'request-1',
      outcome: 'unverified'
    })
    expect(facts[1]).toMatchObject({
      kind: 'dialogueSaveUnsettled',
      requestId: 'request-1',
      outcome: 'failed'
    })
  })

  it('预览开始、草稿有无和结算清除只发窄事实，旧场景不发', () => {
    const { observation, facts } = setup()

    observation.workbench.onDialogueSaveStarted?.({
      scope: SCOPE,
      requestId: 'request-1'
    })
    observation.workbench.onDialogueDraftChanged?.({
      scope: SCOPE,
      dirty: true
    })
    observation.workbench.onDialogueSaveCleared?.({
      scope: SCOPE,
      requestId: 'request-1',
      reason: 'abandoned'
    })
    observation.workbench.onDialogueDraftChanged?.({
      scope: { ...SCOPE, sceneId: 'scene-old' },
      dirty: true
    })
    observation.workbench.onDialogueSaveStarted?.({
      scope: SCOPE,
      requestId: ''
    })

    expect(facts.map((fact) => fact.kind)).toEqual([
      'dialogueSaveStarted',
      'dialogueDraftChanged',
      'dialogueSaveCleared'
    ])
    expect(facts[0]).toMatchObject({ requestId: 'request-1', outcome: 'confirmed' })
    expect(facts[1]).toMatchObject({ dirty: true, outcome: 'confirmed' })
    expect(facts[2]).toMatchObject({ requestId: 'request-1', clearReason: 'abandoned' })
    expect(JSON.stringify(facts)).not.toMatch(/旧句|新句|正文/)

    const bodyKeys = facts.flatMap((fact) => Object.keys(fact))
    expect(bodyKeys).not.toContain('text')
    expect(bodyKeys).not.toContain('dialogueText')
  })

  it('每次真实导出成功发一条，失败结果不伪装成成功', () => {
    const { observation, facts } = setup()

    observation.workbench.onExported?.({ scope: SCOPE, outcome: 'confirmed' })
    observation.workbench.onExported?.({ scope: SCOPE, outcome: 'confirmed' })
    observation.workbench.onExported?.({
      scope: SCOPE,
      outcome: 'failed'
    } as unknown as Parameters<NonNullable<typeof observation.workbench.onExported>>[0])

    expect(facts).toHaveLength(2)
    expect(facts.every((fact) => fact.kind === 'exported')).toBe(true)
    expect(facts[0]).toMatchObject({ sceneId: 'scene-1', outcome: 'confirmed' })
  })

  it('导出失败只发 exportFailed，旧场景不发', () => {
    const { observation, facts } = setup()

    observation.workbench.onExportFailed?.({ scope: SCOPE, outcome: 'failed' })
    observation.workbench.onExportFailed?.({
      scope: { ...SCOPE, sceneId: 'scene-old' },
      outcome: 'failed'
    })

    expect(facts).toHaveLength(1)
    expect(facts[0]).toMatchObject({
      kind: 'exportFailed',
      outcome: 'failed',
      scope: SCOPE
    })
  })
})
