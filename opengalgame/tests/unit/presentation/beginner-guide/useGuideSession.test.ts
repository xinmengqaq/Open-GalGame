import { describe, expect, it, vi } from 'vitest'
import {
  createGuideSessionModel,
  guideSessionReduce,
  resolveInitialGuidePreferences,
  type GuideSessionModel
} from '@presentation/features/beginner-guide/useGuideSession'
import {
  GUIDE_PREFERENCES_KEY,
  createDefaultGuidePreferences,
  readGuidePreferences,
  shouldAutoInvite,
  writeGuidePreferences,
  type GuidePreferenceStorage
} from '@presentation/features/beginner-guide/guidePreferences'
import { GUIDE_STEP_ID } from '@presentation/features/beginner-guide/guideSteps'
import type {
  CandidateAcceptedFact,
  CandidateOpenedFact,
  CandidateReadyFact,
  CandidateReturnedFact,
  CanvasSavedFact,
  CardCreatedFact,
  ConfigSavedFact,
  ConfigTestedFact,
  GenerationFailedFact,
  GenerationStartedFact,
  GuideFact,
  InputSummaryOpenedFact
} from '@presentation/features/beginner-guide/guideObservation'
import { TEST_SCOPE, fact } from './guideFacts'

class MemoryStorage implements GuidePreferenceStorage {
  readonly values = new Map<string, string>()

  getItem(key: string): string | null {
    return this.values.get(key) ?? null
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value)
  }
}

function modelFrom(storage: MemoryStorage): GuideSessionModel {
  return createGuideSessionModel(readGuidePreferences(storage))
}

function reduce(
  model: GuideSessionModel,
  action: Parameters<typeof guideSessionReduce>[1],
  storage?: GuidePreferenceStorage | null
): GuideSessionModel {
  return guideSessionReduce(model, action, storage)
}

function storedPreference(storage: MemoryStorage): {
  version: number
  invitationHandled: boolean
  tutorialModeActive: boolean
  lastStepId: string | null
  lastBeatId: string | null
  entryHidden: boolean
} {
  const raw = storage.getItem(GUIDE_PREFERENCES_KEY)
  expect(raw).not.toBeNull()
  return JSON.parse(raw as string) as {
    version: number
    invitationHandled: boolean
    tutorialModeActive: boolean
    lastStepId: string | null
    lastBeatId: string | null
    entryHidden: boolean
  }
}

function start(storage: MemoryStorage): GuideSessionModel {
  return reduce(modelFrom(storage), { type: 'start-tutorial' }, storage)
}

function reachGenerationWait(storage: MemoryStorage): GuideSessionModel {
  let model = reduce(
    start(storage),
    { type: 'select-step', stepId: GUIDE_STEP_ID.saveAndGenerate, scope: TEST_SCOPE },
    storage
  )
  model = reduce(
    model,
    {
      type: 'fact',
      fact: fact<CanvasSavedFact>({ kind: 'canvasSaved', reason: 'manual' })
    },
    storage
  )
  model = reduce(
    model,
    {
      type: 'fact',
      fact: fact<InputSummaryOpenedFact>({ kind: 'inputSummaryOpened' })
    },
    storage
  )
  return reduce(
    model,
    {
      type: 'fact',
      fact: fact<GenerationStartedFact>({
        kind: 'generationStarted',
        operationId: 'operation-1'
      }),
      scope: TEST_SCOPE
    },
    storage
  )
}

function reachCandidateDecision(storage: MemoryStorage): GuideSessionModel {
  let model = reduce(
    reachGenerationWait(storage),
    {
      type: 'fact',
      fact: fact<CandidateReadyFact>({
        kind: 'candidateReady',
        candidateSnapshotId: 'candidate-1',
        operationId: 'operation-1'
      }),
      scope: TEST_SCOPE
    },
    storage
  )
  model = reduce(
    model,
    {
      type: 'fact',
      fact: fact<CandidateOpenedFact>({
        kind: 'candidateOpened',
        candidateSnapshotId: 'candidate-1'
      }),
      scope: TEST_SCOPE
    },
    storage
  )
  return reduce(
    model,
    {
      type: 'fact',
      fact: fact<CandidateReturnedFact>({ kind: 'candidateReturned' })
    },
    storage
  )
}

function leaveWorkbench(model: GuideSessionModel, storage: MemoryStorage): GuideSessionModel {
  return reduce(
    model,
    {
      type: 'sync-context',
      scope: { projectId: null, sceneId: null, canvasId: null },
      page: 'project-list'
    },
    storage
  )
}

function sendTo(
  model: GuideSessionModel,
  nextFact: GuideFact,
  storage: MemoryStorage
): GuideSessionModel {
  return reduce(model, { type: 'fact', fact: nextFact }, storage)
}

describe('新手指引窗口会话', () => {
  it('初始只给出自动邀请信号，不直接打开邀请', () => {
    const storage = new MemoryStorage()
    const model = modelFrom(storage)

    expect(model.mode).toBe('idle')
    expect(model.guide).toBeNull()
    expect(model.catalogOpen).toBe(false)
    expect(model.exampleOpen).toBe(false)
    expect(shouldAutoInvite(model.preferences)).toBe(true)
  })

  it('初始化时读取本机偏好，恢复邀请已处理与上次步骤', () => {
    const storage = new MemoryStorage()
    writeGuidePreferences(
      {
        version: 1,
        invitationHandled: true,
        tutorialModeActive: false,
        lastStepId: 'arrange-scene',
        lastBeatId: null,
        entryHidden: false
      },
      storage
    )

    expect(resolveInitialGuidePreferences(undefined, storage)).toEqual({
      version: 1,
      invitationHandled: true,
      tutorialModeActive: false,
      lastStepId: 'arrange-scene',
      lastBeatId: null,
      entryHidden: false
    })

    vi.stubGlobal('window', { localStorage: storage })
    try {
      // hook 未传 storage 时走默认本机存储；undefined 不能被当成显式禁用。
      const preferences = resolveInitialGuidePreferences(undefined, undefined)
      expect(preferences).toEqual({
        version: 1,
        invitationHandled: true,
        tutorialModeActive: false,
        lastStepId: 'arrange-scene',
        lastBeatId: null,
        entryHidden: false
      })
      expect(shouldAutoInvite(preferences)).toBe(false)

      const model = createGuideSessionModel()
      expect(model.mode).toBe('idle')
      expect(model.preferences).toEqual(preferences)
      expect(shouldAutoInvite(model.preferences)).toBe(false)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('关闭邀请记为已处理，之后不再自动邀请', () => {
    const storage = new MemoryStorage()
    let model = modelFrom(storage)
    model = reduce(model, { type: 'show-invitation' }, storage)
    expect(model.mode).toBe('invited')
    expect(shouldAutoInvite(modelFrom(storage).preferences)).toBe(false)

    model = reduce(model, { type: 'dismiss-invitation' }, storage)
    expect(model.mode).toBe('idle')
    expect(model.preferences.invitationHandled).toBe(true)
    expect(shouldAutoInvite(model.preferences)).toBe(false)
    expect(storedPreference(storage).invitationHandled).toBe(true)

    expect(reduce(model, { type: 'show-invitation' })).toBe(model)
  })

  it('查看教程立即进入阅读并记录邀请已处理', () => {
    const storage = new MemoryStorage()
    const model = start(storage)

    expect(model.mode).toBe('reading')
    expect(model.guide?.stepId).toBe('configure-model')
    expect(model.preferences.invitationHandled).toBe(true)
    expect(storedPreference(storage)).toMatchObject({
      invitationHandled: true,
      lastStepId: 'configure-model'
    })
  })

  it('没有 lastStepId 从第一步开始，有则恢复该步骤', () => {
    const empty = new MemoryStorage()
    expect(start(empty).guide?.stepId).toBe('configure-model')

    const restored = new MemoryStorage()
    restored.setItem(
      GUIDE_PREFERENCES_KEY,
      JSON.stringify({
        version: 1,
        invitationHandled: true,
        lastStepId: 'arrange-scene'
      })
    )
    expect(start(restored).guide?.stepId).toBe('arrange-scene')
  })

  it('已有配置可显式跳过模型设置并记录阅读位置', () => {
    const storage = new MemoryStorage()
    let model = start(storage)
    model = reduce(model, { type: 'skip-model-config' }, storage)
    expect(model.mode).toBe('reading')
    expect(model.guide?.stepId).toBe('create-project')
    expect(model.guide?.prompt.completion).toBe('已跳过模型设置。')
    expect(storedPreference(storage).lastStepId).toBe('create-project')
  })

  it('旧 lastStepId 不存在时打开目录，不猜步骤', () => {
    const storage = new MemoryStorage()
    storage.setItem(
      GUIDE_PREFERENCES_KEY,
      JSON.stringify({
        version: 1,
        invitationHandled: true,
        lastStepId: 'removed-step'
      })
    )

    let model = start(storage)
    expect(model.mode).toBe('reading')
    expect(model.guide).toBeNull()
    expect(model.catalogOpen).toBe(true)
    expect(model.restoreSignal).toEqual({
      kind: 'open-catalog',
      staleStepId: 'removed-step'
    })

    model = reduce(
      model,
      { type: 'select-step', stepId: 'arrange-scene', scope: TEST_SCOPE },
      storage
    )
    expect(model.guide?.stepId).toBe('arrange-scene')
    expect(model.catalogOpen).toBe(false)
    expect(model.restoreSignal).toBeNull()
    expect(storedPreference(storage).lastStepId).toBe('arrange-scene')
  })

  it('只在步骤变化时更新阅读位置，不记录步骤内部进度或像素', () => {
    const storage = new MemoryStorage()
    let model = start(storage)
    expect(storedPreference(storage).lastStepId).toBe('configure-model')

    model = reduce(
      model,
      {
        type: 'fact',
        fact: fact<ConfigSavedFact>({
          kind: 'configSaved',
          configFingerprint: 'fp-1'
        }),
        scope: TEST_SCOPE
      },
      storage
    )
    expect(model.guide?.milestoneIndex).toBe(1)
    expect(storedPreference(storage).lastStepId).toBe('configure-model')

    model = reduce(
      model,
      {
        type: 'fact',
        fact: fact<ConfigTestedFact>({
          kind: 'configTested',
          configFingerprint: 'fp-1'
        }),
        scope: TEST_SCOPE
      },
      storage
    )
    expect(model.guide?.stepId).toBe('create-project')
    expect(storedPreference(storage).lastStepId).toBe('create-project')
  })

  it('跨页同步上下文保持当前步骤', () => {
    const storage = new MemoryStorage()
    let model = start(storage)
    model = reduce(model, { type: 'sync-context', scope: TEST_SCOPE, page: 'home' }, storage)
    expect(model.guide?.stepId).toBe('configure-model')

    model = reduce(
      model,
      { type: 'select-step', stepId: GUIDE_STEP_ID.saveAndGenerate, scope: TEST_SCOPE },
      storage
    )
    model = reduce(model, { type: 'sync-context', scope: TEST_SCOPE, page: 'workbench' }, storage)
    expect(model.guide?.stepId).toBe('save-and-generate')
  })

  it('切换工程或离开工作台时同步暂停，不依赖下一个业务事实', () => {
    const storage = new MemoryStorage()
    let model = start(storage)
    model = reduce(
      model,
      { type: 'select-step', stepId: 'arrange-scene', scope: TEST_SCOPE },
      storage
    )

    model = reduce(
      model,
      {
        type: 'sync-context',
        scope: { ...TEST_SCOPE, projectId: 'project-2' },
        page: 'workbench'
      },
      storage
    )
    expect(model.guide?.status).toBe('paused')
    expect(model.guide?.prompt.text).toContain('已暂停跟随')

    let left = reduce(
      model,
      {
        type: 'sync-context',
        scope: { projectId: null, sceneId: null, canvasId: null },
        page: 'project-list'
      },
      storage
    )
    expect(left.guide?.status).toBe('paused')

    left = reduce(
      left,
      {
        type: 'fact',
        fact: fact<CardCreatedFact>({
          kind: 'cardCreated',
          cardId: 'image-1',
          cardKind: 'image',
          scope: TEST_SCOPE
        }),
        scope: TEST_SCOPE
      },
      storage
    )
    expect(left.guide?.milestoneIndex).toBe(0)
  })

  it('目录打开期间事实不抢翻，关闭后应用当前提示', () => {
    const storage = new MemoryStorage()
    let model = start(storage)
    model = reduce(model, { type: 'open-catalog' })
    const before = model.guide
    const saved = fact<ConfigSavedFact>({ kind: 'configSaved', configFingerprint: 'fp-1' })

    model = reduce(model, { type: 'fact', fact: saved }, storage)
    expect(model.guide).toBe(before)
    expect(model.deferredFacts).toHaveLength(1)
    expect(storedPreference(storage).lastStepId).toBe('configure-model')

    model = reduce(model, { type: 'close-catalog' }, storage)
    expect(model.guide?.milestoneIndex).toBe(1)
    expect(model.deferredFacts).toHaveLength(0)
  })

  it('示例打开期间同样不抢翻，目录跳步会丢弃暂存事实', () => {
    const storage = new MemoryStorage()
    let model = start(storage)
    model = reduce(model, { type: 'open-example' })
    const tested = fact<ConfigTestedFact>({ kind: 'configTested', configFingerprint: 'fp-1' })

    model = reduce(model, { type: 'fact', fact: tested }, storage)
    expect(model.guide?.milestoneIndex).toBe(0)

    model = reduce(
      model,
      { type: 'select-step', stepId: 'arrange-scene', scope: TEST_SCOPE },
      storage
    )
    expect(model.guide?.stepId).toBe('arrange-scene')
    expect(model.guide?.milestoneIndex).toBe(0)
    expect(model.deferredFacts).toHaveLength(0)
    expect(model.exampleOpen).toBe(false)
  })

  it('目录和示例不叠层', () => {
    const storage = new MemoryStorage()
    let model = start(storage)

    model = reduce(model, { type: 'open-catalog' })
    expect(model.catalogOpen).toBe(true)

    model = reduce(model, { type: 'open-example' })
    expect(model.exampleOpen).toBe(true)
    expect(model.catalogOpen).toBe(false)

    model = reduce(model, { type: 'open-catalog' })
    expect(model.catalogOpen).toBe(true)
    expect(model.exampleOpen).toBe(false)
  })

  it('第 6 步收起去试玩，返回后自动展开并显示决定提示', () => {
    const storage = new MemoryStorage()
    let model = start(storage)
    model = reduce(
      model,
      { type: 'select-step', stepId: GUIDE_STEP_ID.playtestCandidate, scope: TEST_SCOPE },
      storage
    )

    model = reduce(
      model,
      {
        type: 'fact',
        fact: fact<CandidateReadyFact>({
          kind: 'candidateReady',
          candidateSnapshotId: 'candidate-1'
        }),
        scope: TEST_SCOPE
      },
      storage
    )
    model = reduce(
      model,
      {
        type: 'fact',
        fact: fact<CandidateOpenedFact>({
          kind: 'candidateOpened',
          candidateSnapshotId: 'candidate-1'
        }),
        scope: TEST_SCOPE
      },
      storage
    )
    expect(model.guide?.prompt.hidden).toBe(false)
    expect(model.guide?.prompt.text).toContain('正在试玩候选')

    model = reduce(model, { type: 'collapse-for-trial' })
    expect(model.collapsedForTrial).toBe(true)
    expect(model.guide?.collapsed).toBe(true)

    model = reduce(
      model,
      {
        type: 'fact',
        fact: fact<CandidateReturnedFact>({ kind: 'candidateReturned' })
      },
      storage
    )
    expect(model.collapsedForTrial).toBe(false)
    expect(model.guide?.collapsed).toBe(false)
    expect(model.guide?.candidatePhase).toBe('returned')
    expect(model.guide?.prompt.hidden).toBe(false)
    expect(model.guide?.prompt.tone).toBe('decision')
  })

  it('退出清理会话后不再接受事实，可重新开始', () => {
    const storage = new MemoryStorage()
    let model = start(storage)
    model = reduce(model, { type: 'exit' }, storage)
    expect(model.mode).toBe('idle')
    expect(model.guide).toBeNull()

    const afterExit = reduce(
      model,
      {
        type: 'fact',
        fact: fact<ConfigTestedFact>({
          kind: 'configTested',
          configFingerprint: 'fp-1'
        }),
        scope: TEST_SCOPE
      },
      storage
    )
    expect(afterExit.guide).toBeNull()

    model = reduce(model, { type: 'start-tutorial' }, storage)
    expect(model.guide?.stepId).toBe('configure-model')
  })

  it('存储不可用时仍能在当前窗口跟做', () => {
    let model = createGuideSessionModel(createDefaultGuidePreferences())
    model = reduce(model, { type: 'start-tutorial' }, null)
    expect(model.mode).toBe('reading')
    expect(model.guide?.stepId).toBe('configure-model')
    expect(model.preferences.invitationHandled).toBe(true)
    expect(model.preferences.lastStepId).toBe('configure-model')

    model = reduce(
      model,
      {
        type: 'fact',
        fact: fact<ConfigSavedFact>({
          kind: 'configSaved',
          configFingerprint: 'fp-1'
        }),
        scope: TEST_SCOPE
      },
      null
    )
    expect(model.guide?.milestoneIndex).toBe(1)
  })

  it('目录选择步骤只改提示，不把等待动作补记为成功', () => {
    const storage = new MemoryStorage()
    let model = start(storage)
    model = reduce(
      model,
      { type: 'select-step', stepId: GUIDE_STEP_ID.exportBuild, scope: TEST_SCOPE },
      storage
    )

    expect(model.guide?.stepId).toBe('export-build')
    expect(model.guide?.milestoneIndex).toBe(0)
    expect(model.guide?.status).toBe('following')
    expect(model.guide?.prompt.completion).toBe('已跳到这一步。')
  })

  it('暂停期间候选就绪不推进，恢复同一工程时补齐第 6 步', () => {
    const storage = new MemoryStorage()
    let model = leaveWorkbench(reachGenerationWait(storage), storage)
    expect(model.guide?.status).toBe('paused')
    expect(model.guide?.milestoneIndex).toBe(2)

    model = sendTo(
      model,
      fact<CandidateReadyFact>({
        kind: 'candidateReady',
        candidateSnapshotId: 'candidate-1',
        operationId: 'operation-1'
      }),
      storage
    )
    expect(model.guide?.stepId).toBe(GUIDE_STEP_ID.saveAndGenerate)
    expect(model.guide?.milestoneIndex).toBe(2)
    expect(model.guide?.activeCandidateSnapshotId).toBeNull()
    expect(model.guide?.prompt.title).toBe('跟做已停在这里')
    expect(model.pausedFacts).toHaveLength(1)

    model = reduce(model, { type: 'resume', scope: TEST_SCOPE }, storage)
    expect(model.guide?.status).toBe('following')
    expect(model.guide?.stepId).toBe(GUIDE_STEP_ID.playtestCandidate)
    expect(model.guide?.milestoneIndex).toBe(1)
    expect(model.guide?.activeCandidateSnapshotId).toBe('candidate-1')
    expect(model.pausedFacts).toHaveLength(0)
  })

  it('暂停期间生成失败不推进，恢复同一工程后显示失败等待重试', () => {
    const storage = new MemoryStorage()
    let model = leaveWorkbench(reachGenerationWait(storage), storage)

    model = sendTo(
      model,
      fact<GenerationFailedFact>({
        kind: 'generationFailed',
        operationId: 'operation-1'
      }),
      storage
    )
    expect(model.guide?.status).toBe('paused')
    expect(model.guide?.stepId).toBe(GUIDE_STEP_ID.saveAndGenerate)
    expect(model.guide?.generationRunState).toBe('running')

    model = reduce(model, { type: 'resume', scope: TEST_SCOPE }, storage)
    expect(model.guide?.status).toBe('following')
    expect(model.guide?.stepId).toBe(GUIDE_STEP_ID.saveAndGenerate)
    expect(model.guide?.milestoneIndex).toBe(2)
    expect(model.guide?.generationRunState).toBe('failed')
    expect(model.guide?.generationOperationId).toBeNull()
    expect(model.guide?.prompt.title).toBe('这一版没生成出来')
  })

  it('暂停期间正式提交不推进第 6 步，恢复同一工程后才进入第 7 步', () => {
    const storage = new MemoryStorage()
    let model = leaveWorkbench(reachCandidateDecision(storage), storage)
    expect(model.guide?.candidatePhase).toBe('returned')

    model = sendTo(
      model,
      fact<CandidateAcceptedFact>({
        kind: 'candidateAccepted',
        candidateSnapshotId: 'candidate-1',
        operationId: 'operation-1'
      }),
      storage
    )
    expect(model.guide?.stepId).toBe(GUIDE_STEP_ID.playtestCandidate)
    expect(model.guide?.milestoneIndex).toBe(1)
    expect(model.guide?.prompt.title).toBe('跟做已停在这里')

    model = reduce(model, { type: 'resume', scope: TEST_SCOPE }, storage)
    expect(model.guide?.stepId).toBe(GUIDE_STEP_ID.polishDialogue)
    expect(model.guide?.milestoneIndex).toBe(0)
  })

  it('正式提交先于就绪通知到达时，恢复后从第 5 步补齐到第 7 步', () => {
    const storage = new MemoryStorage()
    let model = leaveWorkbench(reachGenerationWait(storage), storage)

    model = sendTo(
      model,
      fact<CandidateAcceptedFact>({
        kind: 'candidateAccepted',
        candidateSnapshotId: 'candidate-1',
        operationId: 'operation-1'
      }),
      storage
    )
    expect(model.guide?.stepId).toBe(GUIDE_STEP_ID.saveAndGenerate)
    expect(model.guide?.milestoneIndex).toBe(2)

    model = reduce(model, { type: 'resume', scope: TEST_SCOPE }, storage)
    expect(model.guide?.stepId).toBe(GUIDE_STEP_ID.polishDialogue)
    expect(model.guide?.milestoneIndex).toBe(0)
  })

  it('恢复其他工程或操作时不补播暂停期间的旧终态', () => {
    const storage = new MemoryStorage()
    let model = leaveWorkbench(reachCandidateDecision(storage), storage)

    model = sendTo(
      model,
      fact<CandidateAcceptedFact>({
        kind: 'candidateAccepted',
        candidateSnapshotId: 'candidate-1',
        operationId: 'operation-2'
      }),
      storage
    )
    model = sendTo(
      model,
      fact<CandidateAcceptedFact>({
        kind: 'candidateAccepted',
        candidateSnapshotId: 'candidate-2',
        operationId: 'operation-1'
      }),
      storage
    )
    model = reduce(model, { type: 'resume', scope: TEST_SCOPE }, storage)
    expect(model.guide?.stepId).toBe(GUIDE_STEP_ID.playtestCandidate)
    expect(model.guide?.milestoneIndex).toBe(1)

    let switched = leaveWorkbench(reachGenerationWait(storage), storage)
    switched = sendTo(
      switched,
      fact<CandidateReadyFact>({
        kind: 'candidateReady',
        candidateSnapshotId: 'candidate-1',
        operationId: 'operation-1'
      }),
      storage
    )
    switched = reduce(
      switched,
      {
        type: 'resume',
        scope: { projectId: 'project-2', sceneId: 'scene-2', canvasId: 'canvas-2' }
      },
      storage
    )
    expect(switched.guide?.stepId).toBe(GUIDE_STEP_ID.saveAndGenerate)
    expect(switched.guide?.milestoneIndex).toBe(0)
    expect(switched.guide?.activeCandidateSnapshotId).toBeNull()
    expect(switched.guide?.generationOperationId).toBeNull()
    expect(switched.pausedFacts).toHaveLength(0)
  })

  it('重复的暂停终态只保留一次，跳步清空未补播的终态', () => {
    const storage = new MemoryStorage()
    let model = leaveWorkbench(reachGenerationWait(storage), storage)
    const ready = fact<CandidateReadyFact>({
      kind: 'candidateReady',
      candidateSnapshotId: 'candidate-1',
      operationId: 'operation-1'
    })

    model = sendTo(model, ready, storage)
    model = sendTo(model, ready, storage)
    expect(model.pausedFacts).toHaveLength(1)

    model = reduce(
      model,
      { type: 'select-step', stepId: GUIDE_STEP_ID.exportBuild, scope: TEST_SCOPE },
      storage
    )
    expect(model.guide?.stepId).toBe(GUIDE_STEP_ID.exportBuild)
    expect(model.guide?.milestoneIndex).toBe(0)
    expect(model.pausedFacts).toHaveLength(0)
  })

  it('暂停期间新操作就绪后，旧操作的迟到接受不推进新练习', () => {
    const storage = new MemoryStorage()
    let model = leaveWorkbench(reachGenerationWait(storage), storage)

    model = sendTo(
      model,
      fact<CandidateAcceptedFact>({
        kind: 'candidateAccepted',
        candidateSnapshotId: 'candidate-1',
        operationId: 'operation-1'
      }),
      storage
    )
    model = sendTo(
      model,
      fact<GenerationStartedFact>({
        kind: 'generationStarted',
        operationId: 'operation-2'
      }),
      storage
    )
    model = sendTo(
      model,
      fact<CandidateReadyFact>({
        kind: 'candidateReady',
        candidateSnapshotId: 'candidate-2',
        operationId: 'operation-2'
      }),
      storage
    )
    expect(model.guide?.stepId).toBe(GUIDE_STEP_ID.saveAndGenerate)

    model = reduce(model, { type: 'resume', scope: TEST_SCOPE }, storage)
    expect(model.guide?.stepId).toBe(GUIDE_STEP_ID.playtestCandidate)
    expect(model.guide?.milestoneIndex).toBe(1)
    expect(model.guide?.activeCandidateSnapshotId).toBe('candidate-2')
    expect(model.guide?.generationOperationId).toBe('operation-2')
  })

  it('暂停期间的画布手动操作不算练习，退出清空未补播终态', () => {
    const storage = new MemoryStorage()
    let model = reduce(
      start(storage),
      { type: 'select-step', stepId: GUIDE_STEP_ID.arrangeScene, scope: TEST_SCOPE },
      storage
    )
    model = leaveWorkbench(model, storage)
    model = sendTo(
      model,
      fact<CardCreatedFact>({ kind: 'cardCreated', cardId: 'image-1', cardKind: 'image' }),
      storage
    )
    expect(model.guide?.status).toBe('paused')
    expect(model.pausedFacts).toHaveLength(0)

    model = reduce(model, { type: 'resume', scope: TEST_SCOPE }, storage)
    expect(model.guide?.stepId).toBe(GUIDE_STEP_ID.arrangeScene)
    expect(model.guide?.milestoneIndex).toBe(0)
    expect(model.guide?.arrangeCards).toEqual({})

    let pending = leaveWorkbench(reachGenerationWait(storage), storage)
    pending = sendTo(
      pending,
      fact<CandidateReadyFact>({
        kind: 'candidateReady',
        candidateSnapshotId: 'candidate-1',
        operationId: 'operation-1'
      }),
      storage
    )
    expect(pending.pausedFacts).toHaveLength(1)
    pending = reduce(pending, { type: 'exit' }, storage)
    expect(pending.guide).toBeNull()
    expect(pending.pausedFacts).toHaveLength(0)

    pending = reduce(pending, { type: 'start-tutorial' }, storage)
    expect(pending.guide?.stepId).toBe(GUIDE_STEP_ID.saveAndGenerate)
    expect(pending.guide?.milestoneIndex).toBe(0)
    expect(pending.pausedFacts).toHaveLength(0)
  })

  it('自由前进后退以最后查看位置为准，跳过的步骤不写完成记录', () => {
    const storage = new MemoryStorage()
    let model = start(storage)
    expect(model.guide?.stepId).toBe(GUIDE_STEP_ID.configureModel)

    model = reduce(model, { type: 'go-next' }, storage)
    expect(model.guide?.stepId).toBe(GUIDE_STEP_ID.createProject)
    expect(model.guide?.completedSteps).toEqual([])
    expect(storedPreference(storage).lastStepId).toBe(GUIDE_STEP_ID.createProject)

    model = reduce(model, { type: 'go-next' }, storage)
    expect(model.guide?.stepId).toBe(GUIDE_STEP_ID.importScript)
    expect(model.guide?.completedSteps).toEqual([])

    model = reduce(model, { type: 'go-previous' }, storage)
    expect(model.guide?.stepId).toBe(GUIDE_STEP_ID.createProject)
    expect(storedPreference(storage).lastStepId).toBe(GUIDE_STEP_ID.createProject)

    const reopened = reduce(modelFrom(storage), { type: 'start-tutorial' }, storage)
    expect(reopened.guide?.stepId).toBe(GUIDE_STEP_ID.createProject)
    expect(reopened.guide?.milestoneIndex).toBe(0)
    expect(reopened.guide?.completedSteps).toEqual([])
  })

  it('第 4 步按拍导航会保存最后查看拍，重开从该拍恢复', () => {
    const storage = new MemoryStorage()
    let model = reduce(
      start(storage),
      { type: 'select-step', stepId: GUIDE_STEP_ID.arrangeScene, scope: TEST_SCOPE },
      storage
    )
    expect(model.guide?.milestoneIndex).toBe(0)

    model = reduce(model, { type: 'go-next' }, storage)
    expect(model.guide?.stepId).toBe(GUIDE_STEP_ID.arrangeScene)
    expect(model.guide?.milestoneIndex).toBe(4)
    expect(storedPreference(storage)).toMatchObject({
      lastStepId: GUIDE_STEP_ID.arrangeScene,
      lastBeatId: 'cue'
    })

    const reopened = reduce(modelFrom(storage), { type: 'start-tutorial' }, storage)
    expect(reopened.guide?.stepId).toBe(GUIDE_STEP_ID.arrangeScene)
    expect(reopened.guide?.milestoneIndex).toBe(4)
    expect(reopened.guide?.prompt.title).toBe('先让玩家听见')
    expect(reopened.guide?.completedBeats).toEqual([])
  })

  it('教程模式随偏好持久化：折叠不等退出，退出后重开只留入口', () => {
    const storage = new MemoryStorage()
    let model = reduce(
      start(storage),
      { type: 'select-step', stepId: GUIDE_STEP_ID.arrangeScene, scope: TEST_SCOPE },
      storage
    )
    model = reduce(model, { type: 'go-next' }, storage)
    expect(storedPreference(storage)).toMatchObject({
      tutorialModeActive: true,
      lastStepId: 'arrange-scene',
      lastBeatId: 'cue'
    })

    model = reduce(model, { type: 'collapse' }, storage)
    expect(model.mode).toBe('reading')
    expect(storedPreference(storage).tutorialModeActive).toBe(true)

    model = reduce(model, { type: 'exit' }, storage)
    expect(model.mode).toBe('idle')
    expect(storedPreference(storage)).toMatchObject({
      tutorialModeActive: false,
      lastStepId: 'arrange-scene',
      lastBeatId: 'cue'
    })

    const restarted = createGuideSessionModel(readGuidePreferences(storage), TEST_SCOPE)
    expect(restarted.mode).toBe('idle')
    expect(restarted.guide).toBeNull()

    const invited = reduce(restarted, { type: 'open-invitation' }, storage)
    expect(invited.mode).toBe('invited')
    expect(invited.guide).toBeNull()

    model = reduce(invited, { type: 'start-tutorial', scope: TEST_SCOPE }, storage)
    expect(model.mode).toBe('reading')
    expect(model.guide?.stepId).toBe('arrange-scene')
    expect(model.guide?.milestoneIndex).toBe(4)
    expect(storedPreference(storage).tutorialModeActive).toBe(true)
  })

  it('关闭教程入口后持久隐藏，重新进入教程时恢复', () => {
    const storage = new MemoryStorage()
    let model = reduce(start(storage), { type: 'exit' }, storage)
    expect(model.mode).toBe('idle')

    model = reduce(model, { type: 'hide-entry' }, storage)
    expect(model.preferences.entryHidden).toBe(true)
    expect(storedPreference(storage)).toMatchObject({
      invitationHandled: true,
      entryHidden: true
    })

    const reopened = createGuideSessionModel(readGuidePreferences(storage), TEST_SCOPE)
    expect(reopened.mode).toBe('idle')
    expect(reopened.preferences.entryHidden).toBe(true)

    const restored = reduce(reopened, { type: 'restore-entry' }, storage)
    expect(restored.mode).toBe('idle')
    expect(restored.guide).toBeNull()
    expect(restored.preferences.entryHidden).toBe(false)
    expect(restored.preferences.lastStepId).toBe('configure-model')

    model = reduce(restored, { type: 'start-tutorial', scope: TEST_SCOPE }, storage)
    expect(model.mode).toBe('reading')
    expect(model.preferences.entryHidden).toBe(false)
    expect(storedPreference(storage).entryHidden).toBe(false)
  })

  it('已开启偏好初始化即回到上次步骤，未开启偏好不会自动打开教程', () => {
    const resumed = new MemoryStorage()
    writeGuidePreferences(
      {
        version: 1,
        invitationHandled: true,
        tutorialModeActive: true,
        lastStepId: 'polish-dialogue',
        lastBeatId: null,
        entryHidden: false
      },
      resumed
    )
    const reading = createGuideSessionModel(readGuidePreferences(resumed), TEST_SCOPE)
    expect(reading.mode).toBe('reading')
    expect(reading.guide?.stepId).toBe('polish-dialogue')

    const exited = new MemoryStorage()
    writeGuidePreferences(
      {
        version: 1,
        invitationHandled: true,
        tutorialModeActive: false,
        lastStepId: 'polish-dialogue',
        lastBeatId: null,
        entryHidden: false
      },
      exited
    )
    const idle = createGuideSessionModel(readGuidePreferences(exited), TEST_SCOPE)
    expect(idle.mode).toBe('idle')
    expect(idle.guide).toBeNull()
  })
})
