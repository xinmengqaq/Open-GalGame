import { describe, expect, it } from 'vitest'
import {
  advanceGuide,
  createGuideState,
  currentGuideMilestone,
  guideArrangeViewOf,
  isGuideTerminal,
  restoreGuideSession,
  type GuideSessionState
} from '@presentation/features/beginner-guide/advanceGuide'
import { GUIDE_STEP_ID, type GuideStepId } from '@presentation/features/beginner-guide/guideSteps'
import { canSkipGuideStep } from '@presentation/features/beginner-guide/guidePrompt'
import type {
  CandidateAcceptedFact,
  CandidateDiscardedFact,
  CandidateOpenedFact,
  CandidateReadyFact,
  CandidateReturnedFact,
  CandidateRevisedFact,
  CanvasSavedFact,
  CardCreatedFact,
  CardDeletedFact,
  CardEditedFact,
  CardSelectedFact,
  ConfigChangedFact,
  ConfigSavedFact,
  ConfigTestedFact,
  ConfigTestFailedFact,
  DialogueDraftChangedFact,
  DialogueSaveClearedFact,
  DialogueSaveStartedFact,
  DialogueSavedFact,
  DialogueSaveUnsettledFact,
  DocumentClosedFact,
  DocumentOpenedFact,
  ExportFailedFact,
  ExportedFact,
  GenerationFailedFact,
  GenerationStartedFact,
  GuideFact,
  InputSummaryOpenedFact,
  ProjectCreatedFact,
  ProjectEnteredFact,
  PromptBodySavedFact,
  RelationCreatedFact,
  RelationDeletedFact,
  RelationNamedFact,
  SourceImportedFact
} from '@presentation/features/beginner-guide/guideObservation'
import { TEST_SCOPE, fact } from './guideFacts'

function stateAt(stepId: GuideStepId): GuideSessionState {
  return createGuideState({ stepId, scope: TEST_SCOPE })
}

function send(state: GuideSessionState, nextFact: GuideFact): GuideSessionState {
  return advanceGuide(state, { type: 'fact', fact: nextFact }).state
}

function placed(state: GuideSessionState, cardId: string, cardKind: 'image' | 'audio' | 'prompt') {
  return send(state, fact<CardCreatedFact>({ kind: 'cardCreated', cardId, cardKind }))
}

function edited(state: GuideSessionState, cardId: string, cardKind: 'image' | 'audio') {
  return send(state, fact<CardEditedFact>({ kind: 'cardEdited', cardId, cardKind }))
}

function connected(
  state: GuideSessionState,
  relationId: string,
  fromCardId: string,
  fromCardKind: 'document' | 'image' | 'audio' | 'prompt',
  toCardId: string,
  toCardKind: 'document' | 'image' | 'audio' | 'prompt'
) {
  return send(
    state,
    fact<RelationCreatedFact>({
      kind: 'relationCreated',
      relationId,
      fromCardId,
      fromCardKind,
      toCardId,
      toCardKind
    })
  )
}

function named(
  state: GuideSessionState,
  relationId: string,
  fromCardId: string,
  fromCardKind: 'document' | 'image' | 'audio' | 'prompt',
  toCardId: string,
  toCardKind: 'document' | 'image' | 'audio' | 'prompt'
) {
  return send(
    state,
    fact<RelationNamedFact>({
      kind: 'relationNamed',
      relationId,
      fromCardId,
      fromCardKind,
      toCardId,
      toCardKind
    })
  )
}

function deletedCard(
  state: GuideSessionState,
  cardId: string,
  cardKind: 'document' | 'image' | 'audio' | 'prompt'
) {
  return send(state, fact<CardDeletedFact>({ kind: 'cardDeleted', cardId, cardKind }))
}

function deletedRelation(
  state: GuideSessionState,
  relationId: string,
  fromCardId: string,
  fromCardKind: 'document' | 'image' | 'audio' | 'prompt',
  toCardId: string,
  toCardKind: 'document' | 'image' | 'audio' | 'prompt'
) {
  return send(
    state,
    fact<RelationDeletedFact>({
      kind: 'relationDeleted',
      relationId,
      fromCardId,
      fromCardKind,
      toCardId,
      toCardKind
    })
  )
}

function selected(
  state: GuideSessionState,
  cardId: string,
  cardKind: 'document' | 'image' | 'audio' | 'prompt'
) {
  return send(state, fact<CardSelectedFact>({ kind: 'cardSelected', cardId, cardKind }))
}

/** 依次完成第 n 拍；scriptId 必须是已由用户选用的剧本卡。 */
function completeArrangeBeat(
  state: GuideSessionState,
  beatNumber: number,
  scriptId: string
): GuideSessionState {
  let s = state
  switch (beatNumber) {
    case 1:
      s = placed(s, 'image-1', 'image')
      s = edited(s, 'image-1', 'image')
      s = connected(s, 'relation-1', scriptId, 'document', 'image-1', 'image')
      s = named(s, 'relation-1', scriptId, 'document', 'image-1', 'image')
      return s
    case 2:
      s = placed(s, 'audio-1', 'audio')
      s = edited(s, 'audio-1', 'audio')
      s = connected(s, 'relation-2', 'audio-1', 'audio', 'image-1', 'image')
      s = named(s, 'relation-2', 'audio-1', 'audio', 'image-1', 'image')
      return s
    case 3:
      s = placed(s, 'image-2', 'image')
      s = edited(s, 'image-2', 'image')
      s = connected(s, 'relation-3', 'image-2', 'image', 'image-1', 'image')
      s = named(s, 'relation-3', 'image-2', 'image', 'image-1', 'image')
      return s
    case 4:
      s = placed(s, 'char-1', 'image')
      s = edited(s, 'char-1', 'image')
      s = placed(s, 'char-2', 'image')
      s = edited(s, 'char-2', 'image')
      s = connected(s, 'relation-4', 'char-1', 'image', 'char-2', 'image')
      s = named(s, 'relation-4', 'char-1', 'image', 'char-2', 'image')
      return s
    case 5:
      s = placed(s, 'audio-2', 'audio')
      s = edited(s, 'audio-2', 'audio')
      s = connected(s, 'relation-5', 'audio-2', 'audio', 'image-2', 'image')
      s = named(s, 'relation-5', 'audio-2', 'audio', 'image-2', 'image')
      return s
    case 6:
      s = placed(s, 'prompt-1', 'prompt')
      s = send(s, fact<PromptBodySavedFact>({ kind: 'promptBodySaved', cardId: 'prompt-1' }))
      s = connected(s, 'relation-6', 'prompt-1', 'prompt', scriptId, 'document')
      s = named(s, 'relation-6', 'prompt-1', 'prompt', scriptId, 'document')
      return s
    default:
      throw new Error(`没有第 ${beatNumber} 拍`)
  }
}

/** 从当前拍起依次走完前 through 拍；默认走完六拍。 */
function completeArrangeBeats(
  state: GuideSessionState,
  scriptId: string,
  through = 6
): GuideSessionState {
  let s = state
  for (let beatNumber = 1; beatNumber <= through; beatNumber += 1) {
    s = completeArrangeBeat(s, beatNumber, scriptId)
  }
  return s
}

describe('新手指引推进状态机', () => {
  it('八步里程碑按顺序推进，最后一个里程碑完成才换步', () => {
    let state = createGuideState()

    state = send(state, fact<ConfigSavedFact>({ kind: 'configSaved', configFingerprint: 'fp-1' }))
    expect([state.stepId, state.milestoneIndex]).toEqual(['configure-model', 1])

    state = send(state, fact<ConfigTestedFact>({ kind: 'configTested', configFingerprint: 'fp-1' }))
    expect([state.stepId, state.milestoneIndex]).toEqual(['create-project', 0])

    state = send(state, fact<ProjectCreatedFact>({ kind: 'projectCreated', scope: TEST_SCOPE }))
    expect([state.stepId, state.milestoneIndex]).toEqual(['create-project', 1])

    state = send(state, fact<ProjectEnteredFact>({ kind: 'projectEntered', scope: TEST_SCOPE }))
    expect([state.stepId, state.milestoneIndex]).toEqual(['import-script', 0])

    state = send(
      state,
      fact<SourceImportedFact>({
        kind: 'sourceImported',
        sourceId: 'source-1',
        sourceKind: 'document'
      })
    )
    expect([state.stepId, state.milestoneIndex]).toEqual(['import-script', 1])

    state = send(
      state,
      fact<CardCreatedFact>({
        kind: 'cardCreated',
        cardId: 'document-1',
        cardKind: 'document'
      })
    )
    expect([state.stepId, state.milestoneIndex]).toEqual(['import-script', 2])

    state = send(state, fact<DocumentOpenedFact>({ kind: 'documentOpened', cardId: 'document-1' }))
    expect([state.stepId, state.milestoneIndex]).toEqual(['import-script', 2])
    expect(state.prompt.title).toBe('查看或编辑正文')

    state = send(state, fact<DocumentClosedFact>({ kind: 'documentClosed', cardId: 'document-1' }))
    expect([state.stepId, state.milestoneIndex]).toEqual(['arrange-scene', 0])
    expect(state.arrangeCards).toEqual({ script: 'document-1' })
    expect(guideArrangeViewOf(state)).toMatchObject({
      beatNumber: 1,
      beatTotal: 6,
      stage: 'place',
      cardKind: 'image'
    })

    state = completeArrangeBeats(state, 'document-1')
    expect([state.stepId, state.milestoneIndex]).toEqual(['arrange-scene', 26])
    expect(state.prompt.confirmLabel).toBe('编排好了')
    expect(guideArrangeViewOf(state)).toMatchObject({
      beatNumber: 6,
      beatTotal: 6,
      complete: true
    })

    state = advanceGuide(state, { type: 'confirm-step' }).state
    expect([state.stepId, state.milestoneIndex]).toEqual(['save-and-generate', 0])

    state = send(state, fact<CanvasSavedFact>({ kind: 'canvasSaved', reason: 'manual' }))
    expect([state.stepId, state.milestoneIndex]).toEqual(['save-and-generate', 1])

    state = send(state, fact<InputSummaryOpenedFact>({ kind: 'inputSummaryOpened' }))
    expect([state.stepId, state.milestoneIndex]).toEqual(['save-and-generate', 2])

    state = send(
      state,
      fact<GenerationStartedFact>({ kind: 'generationStarted', operationId: 'operation-1' })
    )
    expect([state.stepId, state.milestoneIndex]).toEqual(['save-and-generate', 2])
    expect(state.generationOperationId).toBe('operation-1')
    expect(state.generationRunState).toBe('running')
    expect(state.prompt.title).toBe('等候这一版候选')

    state = send(
      state,
      fact<CandidateReadyFact>({
        kind: 'candidateReady',
        candidateSnapshotId: 'candidate-1',
        operationId: 'operation-1'
      })
    )
    expect([state.stepId, state.milestoneIndex]).toEqual(['playtest-candidate', 1])
    expect(state.candidatePhase).toBe('ready')

    state = send(
      state,
      fact<CandidateOpenedFact>({
        kind: 'candidateOpened',
        candidateSnapshotId: 'candidate-1'
      })
    )
    expect([state.stepId, state.milestoneIndex]).toEqual(['playtest-candidate', 1])
    expect(state.candidatePhase).toBe('opened')
    expect(state.prompt.hidden).toBe(false)
    expect(state.prompt.text).toContain('正在试玩候选')

    state = send(state, fact<CandidateReturnedFact>({ kind: 'candidateReturned' }))
    expect(state.candidatePhase).toBe('returned')
    expect(state.prompt.tone).toBe('decision')

    state = send(
      state,
      fact<CandidateAcceptedFact>({
        kind: 'candidateAccepted',
        candidateSnapshotId: 'candidate-1',
        operationId: 'operation-1'
      })
    )
    expect([state.stepId, state.milestoneIndex]).toEqual(['polish-dialogue', 0])

    state = send(state, fact<DialogueSavedFact>({ kind: 'dialogueSaved' }))
    expect([state.stepId, state.milestoneIndex]).toEqual(['polish-dialogue', 1])
    expect(state.prompt.confirmLabel).toBe('已确认改动')

    state = advanceGuide(state, { type: 'confirm-step' }).state
    expect([state.stepId, state.milestoneIndex]).toEqual(['export-build', 0])

    state = send(state, fact<ExportedFact>({ kind: 'exported' }))
    expect(state.status).toBe('completed')
    expect(state.prompt.finishLabel).toBe('结束阅读')
    expect(state.prompt.tone).toBe('done')

    const finished = advanceGuide(state, { type: 'finish' })
    expect(finished.state.status).toBe('exited')
    expect(isGuideTerminal(finished.state)).toBe(true)
    expect(finished.effects).toContainEqual({ type: 'guide-exited' })
  })

  it('同一事实重复通知只处理一次，新的同义通知也不重复完成里程碑', () => {
    let state = stateAt(GUIDE_STEP_ID.configureModel)
    const saved = fact<ConfigSavedFact>({
      kind: 'configSaved',
      configFingerprint: 'fp-1'
    })

    state = send(state, saved)
    state = send(state, saved)
    expect(state.milestoneIndex).toBe(1)

    state = send(state, fact<ConfigSavedFact>({ kind: 'configSaved', configFingerprint: 'fp-1' }))
    expect(state.milestoneIndex).toBe(1)
    expect(state.stepId).toBe('configure-model')
  })

  it('一个事实最多完成一个里程碑，不会一次跳两步', () => {
    let state = stateAt(GUIDE_STEP_ID.importScript)
    state = send(
      state,
      fact<SourceImportedFact>({
        kind: 'sourceImported',
        sourceId: 'source-1',
        sourceKind: 'document'
      })
    )
    expect(state.milestoneIndex).toBe(1)

    state = send(
      state,
      fact<CardCreatedFact>({
        kind: 'cardCreated',
        cardId: 'document-1',
        cardKind: 'document'
      })
    )
    expect([state.stepId, state.milestoneIndex]).toEqual(['import-script', 2])
  })

  it('failed、cancelled、unverified 都不推进，点击按钮本身不算成功', () => {
    for (const outcome of ['failed', 'cancelled', 'unverified'] as const) {
      let state = stateAt(GUIDE_STEP_ID.configureModel)
      state = send(
        state,
        fact<ConfigTestedFact>({
          kind: 'configTested',
          configFingerprint: 'fp-1',
          outcome
        })
      )
      expect(state.milestoneIndex).toBe(0)
      expect(state.stepId).toBe('configure-model')
    }

    let state = stateAt(GUIDE_STEP_ID.configureModel)
    state = send(state, fact<ConfigSavedFact>({ kind: 'configSaved', configFingerprint: 'fp-1' }))
    state = send(
      state,
      fact<ConfigTestedFact>({
        kind: 'configTested',
        configFingerprint: 'fp-1',
        outcome: 'failed'
      })
    )
    expect([state.stepId, state.milestoneIndex]).toEqual(['configure-model', 1])

    state = stateAt(GUIDE_STEP_ID.importScript)
    state = send(
      state,
      fact<SourceImportedFact>({
        kind: 'sourceImported',
        sourceId: 'source-1',
        sourceKind: 'document',
        outcome: 'unverified'
      })
    )
    expect(state.milestoneIndex).toBe(0)
  })

  it('旧工程或旧场景的事实直接丢弃', () => {
    let state = stateAt(GUIDE_STEP_ID.importScript)

    state = send(
      state,
      fact<SourceImportedFact>({
        kind: 'sourceImported',
        sourceId: 'source-old-project',
        sourceKind: 'document',
        scope: { projectId: 'project-2', sceneId: 'scene-1' }
      })
    )
    expect(state.milestoneIndex).toBe(0)

    state = send(
      state,
      fact<SourceImportedFact>({
        kind: 'sourceImported',
        sourceId: 'source-old-scene',
        sourceKind: 'document',
        scope: { projectId: 'project-1', sceneId: 'scene-2' }
      })
    )
    expect(state.milestoneIndex).toBe(0)

    state = send(
      state,
      fact<SourceImportedFact>({
        kind: 'sourceImported',
        sourceId: 'source-1',
        sourceKind: 'document'
      })
    )
    expect(state.milestoneIndex).toBe(1)
  })

  it('切工程暂停并解除旧等待，恢复后从本步开头重新等待，不补播', () => {
    let state = stateAt(GUIDE_STEP_ID.importScript)
    state = send(
      state,
      fact<SourceImportedFact>({
        kind: 'sourceImported',
        sourceId: 'source-1',
        sourceKind: 'document'
      })
    )
    expect(state.milestoneIndex).toBe(1)

    const switched = advanceGuide(state, {
      type: 'context-changed',
      scope: { projectId: 'project-2', sceneId: 'scene-2', canvasId: 'canvas-2' }
    })
    state = switched.state
    expect(state.status).toBe('paused')
    expect(switched.effects).toContainEqual({ type: 'paused', reason: 'scope-changed' })

    state = send(
      state,
      fact<CardCreatedFact>({
        kind: 'cardCreated',
        cardId: 'document-2',
        cardKind: 'document',
        scope: { projectId: 'project-2', sceneId: 'scene-2' }
      })
    )
    expect([state.stepId, state.milestoneIndex]).toEqual(['import-script', 1])

    const resumed = advanceGuide(state, {
      type: 'resume',
      scope: { projectId: 'project-2', sceneId: 'scene-2', canvasId: 'canvas-2' }
    })
    state = resumed.state
    expect(state.status).toBe('following')
    expect([state.stepId, state.milestoneIndex]).toEqual(['import-script', 0])
    expect(resumed.effects).toContainEqual({ type: 'resumed' })

    state = send(
      state,
      fact<SourceImportedFact>({
        kind: 'sourceImported',
        sourceId: 'source-2',
        sourceKind: 'document',
        scope: { projectId: 'project-2', sceneId: 'scene-2' }
      })
    )
    expect(state.milestoneIndex).toBe(1)
  })

  it('手动暂停和恢复保留本步进度', () => {
    let state = stateAt(GUIDE_STEP_ID.importScript)
    state = send(
      state,
      fact<SourceImportedFact>({
        kind: 'sourceImported',
        sourceId: 'source-1',
        sourceKind: 'document'
      })
    )
    state = advanceGuide(state, { type: 'pause' }).state
    expect(state.status).toBe('paused')

    state = send(
      state,
      fact<CardCreatedFact>({
        kind: 'cardCreated',
        cardId: 'document-1',
        cardKind: 'document'
      })
    )
    expect(state.milestoneIndex).toBe(1)

    state = advanceGuide(state, { type: 'resume' }).state
    expect(state.status).toBe('following')
    expect([state.stepId, state.milestoneIndex]).toEqual(['import-script', 1])
  })

  it('退出后不再接受任何事实', () => {
    let state = stateAt(GUIDE_STEP_ID.importScript)
    state = advanceGuide(state, { type: 'exit' }).state
    expect(state.status).toBe('exited')

    state = send(
      state,
      fact<SourceImportedFact>({
        kind: 'sourceImported',
        sourceId: 'source-1',
        sourceKind: 'document'
      })
    )
    expect(state.status).toBe('exited')
    expect(state.milestoneIndex).toBe(0)
  })

  it('收起后事实仍处理，展开时看到下一条提示', () => {
    let state = stateAt(GUIDE_STEP_ID.configureModel)
    state = advanceGuide(state, { type: 'collapse' }).state
    expect(state.collapsed).toBe(true)
    expect(state.prompt.hidden).toBe(true)

    state = send(state, fact<ConfigSavedFact>({ kind: 'configSaved', configFingerprint: 'fp-1' }))
    expect(state.milestoneIndex).toBe(1)

    state = advanceGuide(state, { type: 'expand' }).state
    expect(state.collapsed).toBe(false)
    expect(state.prompt.hidden).toBe(false)
    expect(state.prompt.text).toContain('测试连接')
  })

  it('跳步与重开解除旧等待，不把旧事实补记成功', () => {
    let state = stateAt(GUIDE_STEP_ID.configureModel)
    state = send(state, fact<ConfigSavedFact>({ kind: 'configSaved', configFingerprint: 'fp-1' }))
    expect(state.milestoneIndex).toBe(1)

    const selected = advanceGuide(state, {
      type: 'step-selected',
      stepId: GUIDE_STEP_ID.configureModel
    })
    state = selected.state
    expect(state.milestoneIndex).toBe(0)
    expect(state.savedConfigFingerprint).toBeNull()
    expect(state.prompt.completion).toBe('已跳到这一步。')
    expect(selected.effects).toContainEqual({
      type: 'step-entered',
      stepId: 'configure-model'
    })

    state = send(state, fact<ConfigTestedFact>({ kind: 'configTested', configFingerprint: 'fp-1' }))
    expect(state.milestoneIndex).toBe(0)

    state = send(state, fact<ConfigSavedFact>({ kind: 'configSaved', configFingerprint: 'fp-1' }))
    state = send(state, fact<ConfigTestedFact>({ kind: 'configTested', configFingerprint: 'fp-1' }))
    expect(state.stepId).toBe('create-project')

    state = stateAt(GUIDE_STEP_ID.saveAndGenerate)
    state = send(state, fact<CanvasSavedFact>({ kind: 'canvasSaved', reason: 'manual' }))
    expect(state.milestoneIndex).toBe(1)
  })

  it('恢复时没有 lastStepId 从第一步开始，旧 id 请求打开目录', () => {
    const fresh = restoreGuideSession()
    expect(fresh.state.stepId).toBe('configure-model')
    expect(fresh.effects).toEqual([])

    const known = restoreGuideSession({ stepId: 'arrange-scene' })
    expect(known.state.stepId).toBe('arrange-scene')
    expect(known.effects).toEqual([])

    const stale = restoreGuideSession({ stepId: 'removed-step' })
    expect(stale.state.stepId).toBe('configure-model')
    expect(stale.effects).toContainEqual({ type: 'open-catalog', reason: 'unknown-step' })
  })
})

describe('步骤 1：配置模型', () => {
  it('保存后停在测试提示，测试通过进入下一步', () => {
    let state = stateAt(GUIDE_STEP_ID.configureModel)
    state = send(state, fact<ConfigSavedFact>({ kind: 'configSaved', configFingerprint: 'fp-1' }))
    expect([state.stepId, state.milestoneIndex]).toEqual(['configure-model', 1])
    expect(state.savedConfigFingerprint).toBe('fp-1')
    expect(state.prompt.title).toBe('测试一下这份配置')
    expect(state.prompt.text).toContain('测试连接')

    state = send(state, fact<ConfigTestedFact>({ kind: 'configTested', configFingerprint: 'fp-2' }))
    expect(state.stepId).toBe(GUIDE_STEP_ID.createProject)
  })

  it('先测试不抢先完成本步，保存后仍需测试', () => {
    let state = stateAt(GUIDE_STEP_ID.configureModel)
    state = send(state, fact<ConfigTestedFact>({ kind: 'configTested', configFingerprint: 'fp-1' }))
    expect([state.stepId, state.milestoneIndex]).toEqual(['configure-model', 0])
    expect(state.prompt.title).toBe('先接通一个模型')

    state = send(state, fact<ConfigSavedFact>({ kind: 'configSaved', configFingerprint: 'fp-1' }))
    expect(state.milestoneIndex).toBe(1)

    state = send(state, fact<ConfigTestedFact>({ kind: 'configTested', configFingerprint: 'fp-1' }))
    expect(state.stepId).toBe(GUIDE_STEP_ID.createProject)
  })

  it('保存后改配置退回保存提示，重存后再测试', () => {
    let state = stateAt(GUIDE_STEP_ID.configureModel)
    state = send(state, fact<ConfigSavedFact>({ kind: 'configSaved', configFingerprint: 'fp-1' }))
    expect(state.milestoneIndex).toBe(1)

    state = send(state, fact<ConfigChangedFact>({ kind: 'configChanged' }))
    expect([state.stepId, state.milestoneIndex]).toEqual(['configure-model', 0])
    expect(state.savedConfigFingerprint).toBeNull()
    expect(state.prompt.title).toBe('先接通一个模型')
    expect(state.prompt.text).toContain('保存')

    state = send(state, fact<ConfigTestedFact>({ kind: 'configTested', configFingerprint: 'fp-1' }))
    expect(state.milestoneIndex).toBe(0)

    state = send(state, fact<ConfigSavedFact>({ kind: 'configSaved', configFingerprint: 'fp-2' }))
    expect(state.milestoneIndex).toBe(1)
    state = send(state, fact<ConfigTestedFact>({ kind: 'configTested', configFingerprint: 'fp-2' }))
    expect(state.stepId).toBe(GUIDE_STEP_ID.createProject)
  })

  it('重复保存同一配置不重置测试等待', () => {
    let state = stateAt(GUIDE_STEP_ID.configureModel)
    state = send(state, fact<ConfigSavedFact>({ kind: 'configSaved', configFingerprint: 'fp-1' }))
    state = send(state, fact<ConfigSavedFact>({ kind: 'configSaved', configFingerprint: 'fp-1' }))
    expect(state.milestoneIndex).toBe(1)
    expect(state.prompt.title).toBe('测试一下这份配置')
  })

  it('连接测试失败保留等待并显示失败文案，重试通过后继续', () => {
    let state = stateAt(GUIDE_STEP_ID.configureModel)
    state = send(
      state,
      fact<ConfigTestFailedFact>({
        kind: 'configTestFailed',
        configFingerprint: 'fp-1',
        outcome: 'failed'
      })
    )
    expect([state.stepId, state.milestoneIndex]).toEqual(['configure-model', 0])
    expect(state.prompt.title).toBe('连接还没测通')

    state = send(state, fact<ConfigSavedFact>({ kind: 'configSaved', configFingerprint: 'fp-1' }))
    expect(state.milestoneIndex).toBe(1)

    state = send(
      state,
      fact<ConfigTestFailedFact>({
        kind: 'configTestFailed',
        configFingerprint: 'fp-1',
        outcome: 'failed'
      })
    )
    expect(state.milestoneIndex).toBe(1)
    expect(state.savedConfigFingerprint).toBe('fp-1')
    expect(state.prompt.title).toBe('连接还没测通')

    state = send(state, fact<ConfigTestedFact>({ kind: 'configTested', configFingerprint: 'fp-1' }))
    expect(state.stepId).toBe(GUIDE_STEP_ID.createProject)
  })

  it('已有配置可显式跳过，不伪造测试或保存', () => {
    const state = stateAt(GUIDE_STEP_ID.configureModel)
    const skipped = advanceGuide(state, { type: 'skip-model-config' })
    expect(skipped.state.stepId).toBe(GUIDE_STEP_ID.createProject)
    expect(skipped.state.stepAttempt).toBe(state.stepAttempt + 1)
    expect(skipped.state.prompt.completion).toBe('已跳过模型设置。')
    expect(skipped.effects).toContainEqual({
      type: 'step-entered',
      stepId: GUIDE_STEP_ID.createProject
    })

    const elsewhere = stateAt(GUIDE_STEP_ID.createProject)
    expect(advanceGuide(elsewhere, { type: 'skip-model-config' }).state).toBe(elsewhere)
  })
})

describe('步骤 2：创建工程', () => {
  it('只创建不进入不完成，进入别的工程也不算', () => {
    let state = stateAt(GUIDE_STEP_ID.createProject)
    state = send(state, fact<ProjectCreatedFact>({ kind: 'projectCreated', scope: TEST_SCOPE }))
    expect([state.stepId, state.milestoneIndex]).toEqual(['create-project', 1])

    state = send(
      state,
      fact<ProjectEnteredFact>({
        kind: 'projectEntered',
        scope: { projectId: 'project-2', sceneId: 'scene-1' }
      })
    )
    expect([state.stepId, state.milestoneIndex]).toEqual(['create-project', 1])

    state = send(state, fact<ProjectEnteredFact>({ kind: 'projectEntered', scope: TEST_SCOPE }))
    expect([state.stepId, state.milestoneIndex]).toEqual(['import-script', 0])
  })

  it('打开已有工程不算新建', () => {
    let state = stateAt(GUIDE_STEP_ID.createProject)
    state = send(state, fact<ProjectEnteredFact>({ kind: 'projectEntered', scope: TEST_SCOPE }))
    expect([state.stepId, state.milestoneIndex]).toEqual(['create-project', 0])
  })
})

describe('步骤 3：导入剧本', () => {
  it('图片导入不算；文档导入后拖入对应文档卡再阅读', () => {
    let state = stateAt(GUIDE_STEP_ID.importScript)
    state = send(
      state,
      fact<SourceImportedFact>({
        kind: 'sourceImported',
        sourceId: 'image-1',
        sourceKind: 'image'
      })
    )
    expect(state.milestoneIndex).toBe(0)

    state = send(
      state,
      fact<SourceImportedFact>({
        kind: 'sourceImported',
        sourceId: 'source-1',
        sourceKind: 'document'
      })
    )
    expect(state.milestoneIndex).toBe(1)
    expect(state.prompt.title).toBe('把文档拖入画布')

    state = send(
      state,
      fact<CardCreatedFact>({
        kind: 'cardCreated',
        cardId: 'image-card',
        cardKind: 'image'
      })
    )
    expect(state.milestoneIndex).toBe(1)

    state = send(
      state,
      fact<CardCreatedFact>({
        kind: 'cardCreated',
        cardId: 'document-1',
        cardKind: 'document'
      })
    )
    expect(state.milestoneIndex).toBe(2)
    expect(state.prompt.title).toBe('打开文档编辑器')

    state = send(state, fact<DocumentOpenedFact>({ kind: 'documentOpened', cardId: 'document-x' }))
    expect(state.milestoneIndex).toBe(2)

    state = send(state, fact<DocumentOpenedFact>({ kind: 'documentOpened', cardId: 'document-1' }))
    expect([state.stepId, state.milestoneIndex]).toEqual(['import-script', 2])
    expect(state.prompt.title).toBe('查看或编辑正文')

    state = send(state, fact<DocumentClosedFact>({ kind: 'documentClosed', cardId: 'document-x' }))
    expect(state.stepId).toBe('import-script')

    state = send(state, fact<DocumentClosedFact>({ kind: 'documentClosed', cardId: 'document-1' }))
    expect(state.stepId).toBe('arrange-scene')
  })

  it('已有文档实际拖入或点选可直接接续阅读，不要求重复导入', () => {
    let dragged = stateAt(GUIDE_STEP_ID.importScript)
    dragged = send(
      dragged,
      fact<CardCreatedFact>({
        kind: 'cardCreated',
        cardId: 'existing-document',
        cardKind: 'document'
      })
    )
    expect([dragged.stepId, dragged.milestoneIndex]).toEqual(['import-script', 2])
    expect(dragged.documentCardId).toBe('existing-document')
    dragged = send(
      dragged,
      fact<DocumentOpenedFact>({ kind: 'documentOpened', cardId: 'existing-document' })
    )
    expect(dragged.stepId).toBe('import-script')
    dragged = send(
      dragged,
      fact<DocumentClosedFact>({ kind: 'documentClosed', cardId: 'existing-document' })
    )
    expect(dragged.stepId).toBe('arrange-scene')
    expect(dragged.arrangeCards).toEqual({ script: 'existing-document' })

    let selected = stateAt(GUIDE_STEP_ID.importScript)
    selected = send(
      selected,
      fact<CardSelectedFact>({
        kind: 'cardSelected',
        cardId: 'selected-document',
        cardKind: 'document'
      })
    )
    expect([selected.stepId, selected.milestoneIndex]).toEqual(['import-script', 2])
    selected = send(
      selected,
      fact<DocumentOpenedFact>({ kind: 'documentOpened', cardId: 'selected-document' })
    )
    expect(selected.stepId).toBe('import-script')
    selected = send(
      selected,
      fact<DocumentClosedFact>({ kind: 'documentClosed', cardId: 'selected-document' })
    )
    expect(selected.stepId).toBe('arrange-scene')

    let readExisting = stateAt(GUIDE_STEP_ID.importScript)
    readExisting = send(
      readExisting,
      fact<DocumentOpenedFact>({ kind: 'documentOpened', cardId: 'already-placed' })
    )
    expect(readExisting.stepId).toBe('import-script')
    readExisting = send(
      readExisting,
      fact<DocumentClosedFact>({ kind: 'documentClosed', cardId: 'already-placed' })
    )
    expect(readExisting.stepId).toBe('arrange-scene')
    expect(readExisting.arrangeCards).toEqual({ script: 'already-placed' })
  })

  it('导入归属未确认时不推进，实际放卡和阅读仍可继续', () => {
    let state = stateAt(GUIDE_STEP_ID.importScript)
    state = send(
      state,
      fact<SourceImportedFact>({
        kind: 'sourceImported',
        sourceId: 'recovered-source',
        sourceKind: 'document',
        outcome: 'unverified'
      })
    )
    expect([state.stepId, state.milestoneIndex]).toEqual(['import-script', 0])

    state = send(
      state,
      fact<CardCreatedFact>({
        kind: 'cardCreated',
        cardId: 'recovered-document',
        cardKind: 'document'
      })
    )
    expect([state.stepId, state.milestoneIndex]).toEqual(['import-script', 2])

    state = send(
      state,
      fact<DocumentOpenedFact>({ kind: 'documentOpened', cardId: 'recovered-document' })
    )
    expect(state.stepId).toBe('import-script')
    state = send(
      state,
      fact<DocumentClosedFact>({ kind: 'documentClosed', cardId: 'recovered-document' })
    )
    expect(state.stepId).toBe('arrange-scene')
  })
})

describe('步骤 4：编排画面与声音', () => {
  function arrangeState(): GuideSessionState {
    let state = stateAt(GUIDE_STEP_ID.arrangeScene)
    state = send(
      state,
      fact<CardSelectedFact>({
        kind: 'cardSelected',
        cardId: 'script-1',
        cardKind: 'document'
      })
    )
    return state
  }

  function runBeats(
    state: GuideSessionState,
    first: number,
    through: number,
    scriptId = 'script-1'
  ): GuideSessionState {
    let next = state
    for (let beatNumber = first; beatNumber <= through; beatNumber += 1) {
      next = completeArrangeBeat(next, beatNumber, scriptId)
    }
    return next
  }

  /** 删除开场卡重做第一拍后，用画布上已有的后续卡重新完成第 2–6 拍。 */
  function replayBeatsAfterOpeningRebind(
    state: GuideSessionState,
    scriptId = 'script-1'
  ): GuideSessionState {
    let s = state
    s = selected(s, 'audio-1', 'audio')
    s = edited(s, 'audio-1', 'audio')
    s = connected(s, 'relation-2b', 'audio-1', 'audio', 'image-9', 'image')
    s = named(s, 'relation-2b', 'audio-1', 'audio', 'image-9', 'image')

    s = selected(s, 'image-2', 'image')
    s = edited(s, 'image-2', 'image')
    s = connected(s, 'relation-3b', 'image-9', 'image', 'image-2', 'image')
    s = named(s, 'relation-3b', 'image-9', 'image', 'image-2', 'image')

    s = selected(s, 'char-1', 'image')
    s = edited(s, 'char-1', 'image')
    s = selected(s, 'char-2', 'image')
    s = edited(s, 'char-2', 'image')
    s = connected(s, 'relation-4b', 'char-1', 'image', 'char-2', 'image')
    s = named(s, 'relation-4b', 'char-1', 'image', 'char-2', 'image')

    s = selected(s, 'audio-2', 'audio')
    s = edited(s, 'audio-2', 'audio')
    s = connected(s, 'relation-5b', 'audio-2', 'audio', 'image-2', 'image')
    s = named(s, 'relation-5b', 'audio-2', 'audio', 'image-2', 'image')

    s = selected(s, 'prompt-1', 'prompt')
    s = send(s, fact<PromptBodySavedFact>({ kind: 'promptBodySaved', cardId: 'prompt-1' }))
    s = connected(s, 'relation-6b', 'prompt-1', 'prompt', scriptId, 'document')
    s = named(s, 'relation-6b', 'prompt-1', 'prompt', scriptId, 'document')
    return s
  }

  it('六拍依次绑定角色，最后一条关系命名后才允许编排好了', () => {
    let state = arrangeState()
    expect(state.arrangeCards).toEqual({ script: 'script-1' })
    expect(guideArrangeViewOf(state)).toMatchObject({
      beatNumber: 1,
      beatTotal: 6,
      stage: 'place',
      cardKind: 'image',
      cardRole: 'opening',
      complete: false
    })

    state = placed(state, 'image-1', 'image')
    expect(state.milestoneIndex).toBe(1)
    expect(guideArrangeViewOf(state)).toMatchObject({ stage: 'usage', cardRole: 'opening' })

    state = edited(state, 'image-1', 'image')
    expect(state.milestoneIndex).toBe(2)
    expect(guideArrangeViewOf(state)).toMatchObject({
      stage: 'connect',
      relationRoles: ['script', 'opening']
    })

    // 反向拖出同为无向连线，接受。
    state = connected(state, 'relation-1', 'image-1', 'image', 'script-1', 'document')
    expect(state.milestoneIndex).toBe(3)
    expect(state.arrangeRelationId).toBe('relation-1')
    expect(guideArrangeViewOf(state)).toMatchObject({
      stage: 'name',
      relationId: 'relation-1',
      relationFromCardId: 'image-1',
      relationToCardId: 'script-1'
    })

    state = named(state, 'relation-1', 'script-1', 'document', 'image-1', 'image')
    expect(state.milestoneIndex).toBe(4)
    expect(state.arrangeRelationId).toBeNull()
    expect(guideArrangeViewOf(state)).toMatchObject({
      relationId: null,
      relationFromCardId: null,
      relationToCardId: null
    })
    expect(state.arrangeCards).toEqual({ script: 'script-1', opening: 'image-1' })
    expect(state.prompt.text).toContain('选一段短声音')

    state = runBeats(state, 2, 5)
    expect(state.milestoneIndex).toBe(22)
    expect(guideArrangeViewOf(state)).toMatchObject({
      beatId: 'ending',
      beatNumber: 6,
      stage: 'place',
      cardKind: 'prompt',
      cardKindLabel: '提示词卡'
    })

    state = completeArrangeBeat(state, 6, 'script-1')
    expect([state.stepId, state.milestoneIndex]).toEqual(['arrange-scene', 26])
    expect(state.prompt.tone).toBe('decision')
    expect(state.prompt.confirmLabel).toBe('编排好了')
    expect(guideArrangeViewOf(state)).toMatchObject({
      beatNumber: 6,
      beatTotal: 6,
      complete: true
    })

    state = advanceGuide(state, { type: 'confirm-step' }).state
    expect(state.stepId).toBe('save-and-generate')
  })

  it('删除当前拍已绑定卡后回到本拍，新卡可重绑，旧连线不能命名', () => {
    let state = arrangeState()
    state = runBeats(state, 1, 2)
    expect(state.milestoneIndex).toBe(8)

    state = placed(state, 'image-2', 'image')
    state = edited(state, 'image-2', 'image')
    state = connected(state, 'relation-3', 'image-1', 'image', 'image-2', 'image')
    expect(state.milestoneIndex).toBe(11)

    state = deletedCard(state, 'image-2', 'image')
    expect(state.milestoneIndex).toBe(8)
    expect(state.arrangeCards).toEqual({
      script: 'script-1',
      opening: 'image-1',
      cue: 'audio-1'
    })
    expect(state.arrangeRelationId).toBeNull()
    expect(guideArrangeViewOf(state)).toMatchObject({
      beatId: 'scene-change',
      stage: 'place',
      cardRole: 'next-background',
      complete: false
    })

    // 被删除连线上的旧 ID 不能完成新的等待，必须重新连出。
    state = named(state, 'relation-3', 'image-1', 'image', 'image-2', 'image')
    expect(state.milestoneIndex).toBe(8)

    state = placed(state, 'image-9', 'image')
    state = edited(state, 'image-9', 'image')
    state = connected(state, 'relation-3b', 'image-1', 'image', 'image-9', 'image')
    state = named(state, 'relation-3b', 'image-1', 'image', 'image-9', 'image')
    expect(state.milestoneIndex).toBe(12)
    expect(state.arrangeCards['next-background']).toBe('image-9')

    state = runBeats(state, 4, 4)
    state = placed(state, 'audio-2', 'audio')
    state = edited(state, 'audio-2', 'audio')
    state = connected(state, 'relation-5b', 'audio-2', 'audio', 'image-9', 'image')
    state = named(state, 'relation-5b', 'audio-2', 'audio', 'image-9', 'image')
    state = runBeats(state, 6, 6)
    expect(state.milestoneIndex).toBe(26)
    state = advanceGuide(state, { type: 'confirm-step' }).state
    expect(state.stepId).toBe('save-and-generate')
  })

  it('删除待命名连线后回到建线段，旧关系 ID 不能命名新线', () => {
    let state = arrangeState()
    state = runBeats(state, 1, 1)
    state = placed(state, 'audio-1', 'audio')
    state = edited(state, 'audio-1', 'audio')
    state = connected(state, 'relation-2', 'audio-1', 'audio', 'image-1', 'image')
    expect(state.milestoneIndex).toBe(7)

    state = deletedRelation(state, 'relation-2', 'audio-1', 'audio', 'image-1', 'image')
    expect(state.milestoneIndex).toBe(6)
    expect(state.arrangeRelationId).toBeNull()
    expect(state.arrangeCards).toEqual({
      script: 'script-1',
      opening: 'image-1',
      cue: 'audio-1'
    })
    expect(guideArrangeViewOf(state)).toMatchObject({
      beatId: 'cue',
      stage: 'connect',
      relationRoles: ['cue', 'opening']
    })

    state = named(state, 'relation-2', 'audio-1', 'audio', 'image-1', 'image')
    expect(state.milestoneIndex).toBe(6)

    state = connected(state, 'relation-2b', 'audio-1', 'audio', 'image-1', 'image')
    state = named(state, 'relation-2b', 'audio-1', 'audio', 'image-1', 'image')
    expect(state.milestoneIndex).toBe(8)
  })

  it('删除已命名连线后回到对应拍，重新连出后可继续；无关连线不动进度', () => {
    let state = arrangeState()
    state = runBeats(state, 1, 1)
    expect(state.milestoneIndex).toBe(4)
    expect(state.arrangeRelationId).toBeNull()

    state = deletedRelation(state, 'relation-1', 'script-1', 'document', 'image-1', 'image')
    expect(state.milestoneIndex).toBe(2)
    expect(state.arrangeCards).toEqual({ script: 'script-1', opening: 'image-1' })
    expect(guideArrangeViewOf(state)).toMatchObject({
      beatId: 'opening',
      stage: 'connect',
      relationRoles: ['script', 'opening']
    })

    state = deletedRelation(state, 'relation-unrelated', 'random-a', 'image', 'random-b', 'audio')
    expect(state.milestoneIndex).toBe(2)

    state = connected(state, 'relation-1b', 'image-1', 'image', 'script-1', 'document')
    state = named(state, 'relation-1b', 'image-1', 'image', 'script-1', 'document')
    expect(state.milestoneIndex).toBe(4)

    state = runBeats(state, 2, 6)
    state = advanceGuide(state, { type: 'confirm-step' }).state
    expect(state.stepId).toBe('save-and-generate')
  })

  it('完成六拍后删除开场卡会作废旧进度，重新选卡并重做后可再完成', () => {
    let state = arrangeState()
    state = completeArrangeBeats(state, 'script-1', 6)
    expect([state.stepId, state.milestoneIndex]).toEqual(['arrange-scene', 26])
    expect(state.prompt.confirmLabel).toBe('编排好了')

    state = deletedCard(state, 'image-1', 'image')
    expect(state.milestoneIndex).toBe(0)
    expect(state.prompt.confirmLabel).toBeUndefined()
    expect(guideArrangeViewOf(state)).toMatchObject({
      beatNumber: 1,
      stage: 'place',
      cardRole: 'opening',
      complete: false
    })
    expect(state.arrangeCards).not.toHaveProperty('opening')
    expect(state.arrangeCards).toMatchObject({
      script: 'script-1',
      cue: 'audio-1',
      'next-background': 'image-2'
    })
    expect(advanceGuide(state, { type: 'confirm-step' }).state).toBe(state)

    state = placed(state, 'image-9', 'image')
    state = edited(state, 'image-9', 'image')
    state = connected(state, 'relation-1b', 'script-1', 'document', 'image-9', 'image')
    state = named(state, 'relation-1b', 'script-1', 'document', 'image-9', 'image')
    expect(state.milestoneIndex).toBe(4)

    state = replayBeatsAfterOpeningRebind(state)
    expect(state.milestoneIndex).toBe(26)
    expect(state.prompt.confirmLabel).toBe('编排好了')
    state = advanceGuide(state, { type: 'confirm-step' }).state
    expect(state.stepId).toBe('save-and-generate')
  })

  it('删除未绑定的卡不改动第 4 步进度', () => {
    let state = arrangeState()
    state = runBeats(state, 1, 1)
    state = deletedCard(state, 'image-unbound', 'image')
    expect(state.milestoneIndex).toBe(4)
    expect(state.arrangeCards).toEqual({ script: 'script-1', opening: 'image-1' })
  })

  it('同类型不同卡不能顶替：编辑别的图或别的音频不完成当前拍', () => {
    let state = arrangeState()
    state = runBeats(state, 1, 1)

    state = placed(state, 'audio-1', 'audio')
    expect(state.milestoneIndex).toBe(5)
    state = edited(state, 'audio-other', 'audio')
    expect(state.milestoneIndex).toBe(5)
    state = edited(state, 'audio-1', 'audio')
    expect(state.milestoneIndex).toBe(6)

    state = connected(state, 'relation-2', 'audio-1', 'audio', 'image-1', 'image')
    state = named(state, 'relation-2', 'audio-1', 'audio', 'image-1', 'image')
    expect(state.milestoneIndex).toBe(8)

    state = placed(state, 'image-2', 'image')
    expect(state.milestoneIndex).toBe(9)
    state = edited(state, 'image-1', 'image')
    expect(state.milestoneIndex).toBe(9)
    state = edited(state, 'image-2', 'image')
    expect(state.milestoneIndex).toBe(10)

    state = connected(state, 'relation-3', 'image-1', 'image', 'image-2', 'image')
    state = named(state, 'relation-3', 'image-1', 'image', 'image-2', 'image')
    state = runBeats(state, 4, 4)
    expect(state.milestoneIndex).toBe(18)

    state = placed(state, 'audio-2', 'audio')
    expect(state.milestoneIndex).toBe(19)
    state = edited(state, 'audio-1', 'audio')
    expect(state.milestoneIndex).toBe(19)
    state = edited(state, 'audio-2', 'audio')
    expect(state.milestoneIndex).toBe(20)
  })

  it('错端点拒绝，反向无向接受；剧本端点不能换成另一张文档卡', () => {
    let state = arrangeState()
    state = placed(state, 'image-1', 'image')
    state = edited(state, 'image-1', 'image')

    state = connected(state, 'wrong-1', 'image-1', 'image', 'audio-x', 'audio')
    expect(state.milestoneIndex).toBe(2)
    state = connected(state, 'wrong-2', 'image-1', 'image', 'document-other', 'document')
    expect(state.milestoneIndex).toBe(2)
    state = connected(state, 'relation-1', 'script-1', 'document', 'image-1', 'image')
    state = named(state, 'relation-1', 'script-1', 'document', 'image-1', 'image')
    expect(state.milestoneIndex).toBe(4)

    state = runBeats(state, 2, 2)
    state = placed(state, 'image-2', 'image')
    state = edited(state, 'image-2', 'image')
    expect(state.milestoneIndex).toBe(10)
    state = connected(state, 'wrong-3', 'image-1', 'image', 'audio-1', 'audio')
    expect(state.milestoneIndex).toBe(10)
    state = connected(state, 'relation-3', 'image-2', 'image', 'image-1', 'image')
    expect(state.milestoneIndex).toBe(11)
  })

  it('重复与迟到事件不跨拍：第一拍的名字不能结束第二拍', () => {
    let state = arrangeState()
    state = runBeats(state, 1, 1)
    expect(state.milestoneIndex).toBe(4)

    // 第一拍之后的迟到命名、重复编辑和重复建线都不能替第二拍完成。
    state = named(state, 'relation-1', 'script-1', 'document', 'image-1', 'image')
    state = edited(state, 'image-1', 'image')
    state = connected(state, 'relation-1-again', 'image-1', 'image', 'script-1', 'document')
    expect(state.milestoneIndex).toBe(4)

    state = runBeats(state, 2, 2)
    expect(state.milestoneIndex).toBe(8)
    // 同一张已绑定的图不能因为重复/迟到的创建通知改绑到第三拍。
    state = placed(state, 'image-1', 'image')
    state = send(
      state,
      fact<CardSelectedFact>({
        kind: 'cardSelected',
        cardId: 'image-1',
        cardKind: 'image'
      })
    )
    expect(state.milestoneIndex).toBe(8)
    expect(state.arrangeCards).toEqual({
      script: 'script-1',
      opening: 'image-1',
      cue: 'audio-1'
    })
    // 第二拍已结束，第三拍连线建立前的迟到命名不能完成第三拍。
    state = named(state, 'relation-2', 'audio-1', 'audio', 'image-1', 'image')
    expect(state.milestoneIndex).toBe(8)

    state = placed(state, 'image-2', 'image')
    state = edited(state, 'image-2', 'image')
    state = connected(state, 'relation-3', 'image-1', 'image', 'image-2', 'image')
    expect(state.milestoneIndex).toBe(11)
    state = named(state, 'relation-2', 'audio-1', 'audio', 'image-1', 'image')
    expect(state.milestoneIndex).toBe(11)
    state = named(state, 'relation-3', 'image-1', 'image', 'image-2', 'image')
    expect(state.milestoneIndex).toBe(12)
  })

  it('提示词卡创建、正文保存和剧本连线分开；未确认不得结束全场', () => {
    let state = arrangeState()
    state = completeArrangeBeats(state, 'script-1', 5)
    expect(state.milestoneIndex).toBe(22)

    const early = advanceGuide(state, { type: 'confirm-step' }).state
    expect(early).toBe(state)

    state = placed(state, 'prompt-1', 'prompt')
    expect(state.milestoneIndex).toBe(23)
    expect(advanceGuide(state, { type: 'confirm-step' }).state).toBe(state)

    // 别的提示词卡保存正文不算；本地草稿从未进入 reducer。
    state = send(
      state,
      fact<PromptBodySavedFact>({ kind: 'promptBodySaved', cardId: 'prompt-other' })
    )
    expect(state.milestoneIndex).toBe(23)
    state = send(state, fact<PromptBodySavedFact>({ kind: 'promptBodySaved', cardId: 'prompt-1' }))
    expect(state.milestoneIndex).toBe(24)

    state = connected(state, 'relation-6', 'prompt-1', 'prompt', 'script-1', 'document')
    expect(state.milestoneIndex).toBe(25)
    expect(state.prompt.confirmLabel).toBeUndefined()
    state = named(state, 'relation-other', 'prompt-1', 'prompt', 'script-1', 'document')
    expect(state.milestoneIndex).toBe(25)
    expect(advanceGuide(state, { type: 'confirm-step' }).state).toBe(state)

    state = named(state, 'relation-6', 'prompt-1', 'prompt', 'script-1', 'document')
    expect(state.milestoneIndex).toBe(26)
    expect(state.prompt.confirmLabel).toBe('编排好了')
    state = advanceGuide(state, { type: 'confirm-step' }).state
    expect(state.stepId).toBe('save-and-generate')
  })

  it('素材导入、同类卡创建和提示词早建都不算动作完成', () => {
    let state = arrangeState()
    state = send(
      state,
      fact<SourceImportedFact>({
        kind: 'sourceImported',
        sourceId: 'image-source',
        sourceKind: 'image'
      })
    )
    state = send(
      state,
      fact<SourceImportedFact>({
        kind: 'sourceImported',
        sourceId: 'audio-source',
        sourceKind: 'audio'
      })
    )
    state = send(
      state,
      fact<CardCreatedFact>({ kind: 'cardCreated', cardId: 'prompt-early', cardKind: 'prompt' })
    )
    expect(state.milestoneIndex).toBe(0)

    state = placed(state, 'image-1', 'image')
    state = runBeats(state, 1, 1)
    expect(state.milestoneIndex).toBe(4)
    // 第二拍等音频时，拖入另一张图不能顶替。
    state = placed(state, 'image-extra', 'image')
    expect(state.milestoneIndex).toBe(4)
    expect(state.arrangeCards).toEqual({ script: 'script-1', opening: 'image-1' })
  })

  it('第 3 步读过的文档卡沿用到第 4 步；直接跳步或换卡需用户明确选择', () => {
    let state = stateAt(GUIDE_STEP_ID.importScript)
    state = send(
      state,
      fact<SourceImportedFact>({
        kind: 'sourceImported',
        sourceId: 'source-1',
        sourceKind: 'document'
      })
    )
    state = send(
      state,
      fact<CardCreatedFact>({
        kind: 'cardCreated',
        cardId: 'document-1',
        cardKind: 'document'
      })
    )
    state = send(state, fact<DocumentOpenedFact>({ kind: 'documentOpened', cardId: 'document-1' }))
    state = send(state, fact<DocumentClosedFact>({ kind: 'documentClosed', cardId: 'document-1' }))
    expect(state.stepId).toBe('arrange-scene')
    expect(state.arrangeCards).toEqual({ script: 'document-1' })

    // 只在第 3 步建过卡、没有阅读时，目录跳入第 4 步不预绑这张卡。
    let unread = stateAt(GUIDE_STEP_ID.importScript)
    unread = send(
      unread,
      fact<SourceImportedFact>({
        kind: 'sourceImported',
        sourceId: 'source-1',
        sourceKind: 'document'
      })
    )
    unread = send(
      unread,
      fact<CardCreatedFact>({
        kind: 'cardCreated',
        cardId: 'document-1',
        cardKind: 'document'
      })
    )
    expect(unread.milestoneIndex).toBe(2)
    unread = advanceGuide(unread, {
      type: 'step-selected',
      stepId: GUIDE_STEP_ID.arrangeScene
    }).state
    expect(unread.arrangeCards).toEqual({})
    unread = send(
      unread,
      fact<CardSelectedFact>({
        kind: 'cardSelected',
        cardId: 'document-2',
        cardKind: 'document'
      })
    )
    expect(unread.arrangeCards).toEqual({ script: 'document-2' })

    // 直接跳入第 4 步没有沿用旧剧本卡；用户点选一张文档卡后才绑定。
    let direct = stateAt(GUIDE_STEP_ID.arrangeScene)
    expect(direct.arrangeCards).toEqual({})
    direct = send(
      direct,
      fact<CardSelectedFact>({
        kind: 'cardSelected',
        cardId: 'document-2',
        cardKind: 'document'
      })
    )
    expect(direct.arrangeCards).toEqual({ script: 'document-2' })
    direct = send(
      direct,
      fact<CardSelectedFact>({
        kind: 'cardSelected',
        cardId: 'document-3',
        cardKind: 'document'
      })
    )
    expect(direct.arrangeCards).toEqual({ script: 'document-2' })

    // 未显式选过剧本时，用户亲手连出的文档端点可以作为剧本，反向也可。
    let inferred = stateAt(GUIDE_STEP_ID.arrangeScene)
    inferred = placed(inferred, 'image-9', 'image')
    inferred = edited(inferred, 'image-9', 'image')
    inferred = connected(inferred, 'rel-9', 'image-9', 'image', 'document-9', 'document')
    expect(inferred.arrangeCards).toEqual({ opening: 'image-9', script: 'document-9' })
    expect(inferred.milestoneIndex).toBe(3)
  })

  it('暂停保留本拍进度；跳步重开清空绑定；退出后不再接受事实', () => {
    let state = arrangeState()
    state = placed(state, 'image-1', 'image')
    state = advanceGuide(state, { type: 'pause' }).state

    state = send(
      state,
      fact<CardEditedFact>({ kind: 'cardEdited', cardId: 'image-1', cardKind: 'image' })
    )
    expect(state.milestoneIndex).toBe(1)

    state = advanceGuide(state, { type: 'resume' }).state
    expect(state.milestoneIndex).toBe(1)
    expect(state.arrangeCards).toEqual({ script: 'script-1', opening: 'image-1' })

    state = advanceGuide(state, { type: 'step-selected', stepId: GUIDE_STEP_ID.arrangeScene }).state
    expect(state.milestoneIndex).toBe(0)
    expect(state.arrangeCards).toEqual({})

    state = advanceGuide(state, { type: 'exit' }).state
    state = send(
      state,
      fact<CardCreatedFact>({ kind: 'cardCreated', cardId: 'late', cardKind: 'audio' })
    )
    expect(state.status).toBe('exited')
    expect(state.milestoneIndex).toBe(0)
  })
})

describe('步骤 5：保存并生成', () => {
  it('周期自动保存和生成前保存都不算手动保存', () => {
    for (const reason of ['periodic', 'beforeGeneration'] as const) {
      let state = stateAt(GUIDE_STEP_ID.saveAndGenerate)
      state = send(state, fact<CanvasSavedFact>({ kind: 'canvasSaved', reason }))
      expect([state.stepId, state.milestoneIndex]).toEqual(['save-and-generate', 0])
    }
  })

  it('手动保存、打开摘要后开始生成仍留在本步等待候选', () => {
    let state = stateAt(GUIDE_STEP_ID.saveAndGenerate)
    state = send(state, fact<CanvasSavedFact>({ kind: 'canvasSaved', reason: 'manual' }))
    expect(state.milestoneIndex).toBe(1)
    expect(state.prompt.title).toBe('核对送去生成的材料')

    state = send(state, fact<InputSummaryOpenedFact>({ kind: 'inputSummaryOpened' }))
    expect(state.milestoneIndex).toBe(2)
    expect(state.prompt.title).toBe('材料齐了，再开始生成')

    state = send(
      state,
      fact<GenerationStartedFact>({
        kind: 'generationStarted',
        operationId: 'operation-1',
        outcome: 'failed'
      })
    )
    expect([state.stepId, state.milestoneIndex]).toEqual(['save-and-generate', 2])
    expect(state.generationRunState).toBe('idle')

    state = send(
      state,
      fact<GenerationStartedFact>({
        kind: 'generationStarted',
        operationId: 'operation-1'
      })
    )
    expect([state.stepId, state.milestoneIndex]).toEqual(['save-and-generate', 2])
    expect(state.generationOperationId).toBe('operation-1')
    expect(state.generationRunState).toBe('running')
    expect(state.prompt.title).toBe('等候这一版候选')

    state = send(
      state,
      fact<CandidateReadyFact>({
        kind: 'candidateReady',
        candidateSnapshotId: 'candidate-1',
        operationId: 'operation-1'
      })
    )
    expect([state.stepId, state.milestoneIndex]).toEqual(['playtest-candidate', 1])
    expect(state.activeCandidateSnapshotId).toBe('candidate-1')
    expect(state.candidatePhase).toBe('ready')
  })

  it('失败显示原位文案，重试后只接新操作的候选', () => {
    let state = stateAt(GUIDE_STEP_ID.saveAndGenerate)
    state = send(state, fact<CanvasSavedFact>({ kind: 'canvasSaved', reason: 'manual' }))
    state = send(state, fact<InputSummaryOpenedFact>({ kind: 'inputSummaryOpened' }))
    state = send(
      state,
      fact<GenerationStartedFact>({ kind: 'generationStarted', operationId: 'operation-1' })
    )

    state = send(
      state,
      fact<GenerationFailedFact>({ kind: 'generationFailed', operationId: 'operation-old' })
    )
    expect(state.generationRunState).toBe('running')
    expect(state.generationOperationId).toBe('operation-1')

    state = send(
      state,
      fact<GenerationFailedFact>({ kind: 'generationFailed', operationId: 'operation-1' })
    )
    expect([state.stepId, state.milestoneIndex]).toEqual(['save-and-generate', 2])
    expect(state.generationRunState).toBe('failed')
    expect(state.generationOperationId).toBeNull()
    expect(state.prompt.title).toBe('这一版没生成出来')
    expect(state.prompt.text).toContain('修正后从这张画布重试')

    state = send(
      state,
      fact<CandidateReadyFact>({
        kind: 'candidateReady',
        candidateSnapshotId: 'candidate-failed',
        operationId: 'operation-1'
      })
    )
    expect([state.stepId, state.milestoneIndex]).toEqual(['save-and-generate', 2])

    state = send(
      state,
      fact<GenerationStartedFact>({ kind: 'generationStarted', operationId: 'operation-2' })
    )
    expect(state.generationOperationId).toBe('operation-2')
    expect(state.generationRunState).toBe('running')
    expect(state.prompt.title).toBe('等候这一版候选')

    state = send(
      state,
      fact<CandidateReadyFact>({
        kind: 'candidateReady',
        candidateSnapshotId: 'candidate-old',
        operationId: 'operation-1'
      })
    )
    expect([state.stepId, state.milestoneIndex]).toEqual(['save-and-generate', 2])

    state = send(
      state,
      fact<CandidateReadyFact>({
        kind: 'candidateReady',
        candidateSnapshotId: 'candidate-2',
        operationId: 'operation-2'
      })
    )
    expect([state.stepId, state.milestoneIndex]).toEqual(['playtest-candidate', 1])
    expect(state.activeCandidateSnapshotId).toBe('candidate-2')
  })

  it('第 6 步只接受本次生成操作的候选', () => {
    let state = stateAt(GUIDE_STEP_ID.saveAndGenerate)
    state = send(state, fact<CanvasSavedFact>({ kind: 'canvasSaved', reason: 'manual' }))
    state = send(state, fact<InputSummaryOpenedFact>({ kind: 'inputSummaryOpened' }))
    state = send(
      state,
      fact<GenerationStartedFact>({ kind: 'generationStarted', operationId: 'operation-1' })
    )
    state = send(
      state,
      fact<CandidateReadyFact>({
        kind: 'candidateReady',
        candidateSnapshotId: 'candidate-old',
        operationId: 'operation-old'
      })
    )
    expect([state.stepId, state.milestoneIndex]).toEqual(['save-and-generate', 2])

    state = send(
      state,
      fact<CandidateReadyFact>({
        kind: 'candidateReady',
        candidateSnapshotId: 'candidate-1',
        operationId: 'operation-1'
      })
    )
    expect([state.stepId, state.milestoneIndex]).toEqual(['playtest-candidate', 1])
  })
})

describe('步骤 6：试玩并决定', () => {
  function readyState(): GuideSessionState {
    let state = stateAt(GUIDE_STEP_ID.playtestCandidate)
    state = send(
      state,
      fact<CandidateReadyFact>({
        kind: 'candidateReady',
        candidateSnapshotId: 'candidate-1'
      })
    )
    return state
  }

  function returnedState(): GuideSessionState {
    let state = readyState()
    state = send(
      state,
      fact<CandidateOpenedFact>({
        kind: 'candidateOpened',
        candidateSnapshotId: 'candidate-1'
      })
    )
    state = send(state, fact<CandidateReturnedFact>({ kind: 'candidateReturned' }))
    return state
  }

  it('候选就绪、打开、返回、接受并提交的完整分支', () => {
    let state = readyState()
    expect([state.stepId, state.milestoneIndex]).toEqual(['playtest-candidate', 1])
    expect(state.candidatePhase).toBe('ready')
    expect(state.prompt.title).toBe('从头玩一遍')
    expect(state.prompt.text).toContain('打开游戏候选')

    const opened = advanceGuide(state, {
      type: 'fact',
      fact: fact<CandidateOpenedFact>({
        kind: 'candidateOpened',
        candidateSnapshotId: 'candidate-1'
      })
    })
    state = opened.state
    expect(state.candidatePhase).toBe('opened')
    expect(state.prompt.hidden).toBe(false)
    expect(opened.effects).toContainEqual({ type: 'overlay-shown' })
    expect(state.stepId).toBe('playtest-candidate')

    const returned = advanceGuide(state, {
      type: 'fact',
      fact: fact<CandidateReturnedFact>({ kind: 'candidateReturned' })
    })
    state = returned.state
    expect(state.candidatePhase).toBe('returned')
    expect(state.prompt.tone).toBe('decision')
    expect(state.prompt.title).toBe('和你想的一样吗？')
    expect(returned.effects).toContainEqual({ type: 'overlay-shown' })

    state = send(
      state,
      fact<CandidateAcceptedFact>({
        kind: 'candidateAccepted',
        candidateSnapshotId: 'candidate-1',
        operationId: 'operation-1'
      })
    )
    expect([state.stepId, state.milestoneIndex]).toEqual(['polish-dialogue', 0])
  })

  it('打开候选不是完成，未打开就返回也不推进', () => {
    let state = readyState()
    state = send(
      state,
      fact<CandidateOpenedFact>({
        kind: 'candidateOpened',
        candidateSnapshotId: 'candidate-1'
      })
    )
    expect([state.stepId, state.milestoneIndex]).toEqual(['playtest-candidate', 1])

    let withoutOpen = readyState()
    withoutOpen = send(withoutOpen, fact<CandidateReturnedFact>({ kind: 'candidateReturned' }))
    expect(withoutOpen.candidatePhase).toBe('ready')
    expect(withoutOpen.milestoneIndex).toBe(1)
  })

  it('接受其他候选或没有活动候选都不推进', () => {
    let state = returnedState()
    state = send(
      state,
      fact<CandidateAcceptedFact>({
        kind: 'candidateAccepted',
        candidateSnapshotId: 'candidate-other',
        operationId: 'operation-1'
      })
    )
    expect([state.stepId, state.milestoneIndex]).toEqual(['playtest-candidate', 1])

    let noCandidate = stateAt(GUIDE_STEP_ID.playtestCandidate)
    noCandidate = send(
      noCandidate,
      fact<CandidateAcceptedFact>({
        kind: 'candidateAccepted',
        candidateSnapshotId: 'candidate-1',
        operationId: 'operation-1'
      })
    )
    expect(noCandidate.milestoneIndex).toBe(0)
  })

  it('提出修改后等新候选，旧候选事实不会误推进', () => {
    let state = returnedState()
    state = send(
      state,
      fact<CandidateRevisedFact>({
        kind: 'candidateRevised',
        candidateSnapshotId: 'candidate-1'
      })
    )
    expect(state.candidatePhase).toBe('revised')
    expect(state.activeCandidateSnapshotId).toBeNull()
    expect(state.prompt.title).toBe('正在改这一版')
    expect(state.prompt.text).toContain('新候选')

    state = send(
      state,
      fact<CandidateReadyFact>({
        kind: 'candidateReady',
        candidateSnapshotId: 'candidate-1'
      })
    )
    expect(state.candidatePhase).toBe('revised')
    expect(state.activeCandidateSnapshotId).toBeNull()

    state = send(
      state,
      fact<CandidateAcceptedFact>({
        kind: 'candidateAccepted',
        candidateSnapshotId: 'candidate-1',
        operationId: 'operation-1'
      })
    )
    expect(state.stepId).toBe('playtest-candidate')

    state = send(
      state,
      fact<CandidateReadyFact>({
        kind: 'candidateReady',
        candidateSnapshotId: 'candidate-2'
      })
    )
    expect(state.candidatePhase).toBe('ready')
    expect(state.activeCandidateSnapshotId).toBe('candidate-2')
    expect(state.candidateReplay).toBe(true)
    expect(state.prompt.title).toBe('再玩一次刚才不对的地方')

    state = send(
      state,
      fact<CandidateOpenedFact>({
        kind: 'candidateOpened',
        candidateSnapshotId: 'candidate-2'
      })
    )
    state = send(
      state,
      fact<CandidateAcceptedFact>({
        kind: 'candidateAccepted',
        candidateSnapshotId: 'candidate-2',
        operationId: 'operation-2'
      })
    )
    expect(state.stepId).toBe('polish-dialogue')
  })

  it('丢弃候选停留本步，不推进到导出，新候选可继续', () => {
    let state = returnedState()
    state = send(
      state,
      fact<CandidateDiscardedFact>({
        kind: 'candidateDiscarded',
        candidateSnapshotId: 'candidate-1'
      })
    )
    expect(state.candidatePhase).toBe('discarded')
    expect(state.activeCandidateSnapshotId).toBeNull()
    expect([state.stepId, state.milestoneIndex]).toEqual(['playtest-candidate', 1])

    state = send(
      state,
      fact<CandidateAcceptedFact>({
        kind: 'candidateAccepted',
        candidateSnapshotId: 'candidate-1',
        operationId: 'operation-1'
      })
    )
    expect(state.stepId).toBe('playtest-candidate')

    state = send(
      state,
      fact<CandidateReadyFact>({
        kind: 'candidateReady',
        candidateSnapshotId: 'candidate-2'
      })
    )
    expect(state.candidatePhase).toBe('ready')

    state = send(
      state,
      fact<CandidateOpenedFact>({
        kind: 'candidateOpened',
        candidateSnapshotId: 'candidate-2'
      })
    )
    state = send(
      state,
      fact<CandidateAcceptedFact>({
        kind: 'candidateAccepted',
        candidateSnapshotId: 'candidate-2',
        operationId: 'operation-2'
      })
    )
    expect(state.stepId).toBe('polish-dialogue')
  })

  it('丢弃后旧操作的迟到候选不复活，新操作就绪后再试玩', () => {
    let state = stateAt(GUIDE_STEP_ID.saveAndGenerate)
    state = send(state, fact<CanvasSavedFact>({ kind: 'canvasSaved', reason: 'manual' }))
    state = send(state, fact<InputSummaryOpenedFact>({ kind: 'inputSummaryOpened' }))
    state = send(
      state,
      fact<GenerationStartedFact>({ kind: 'generationStarted', operationId: 'operation-1' })
    )
    state = send(
      state,
      fact<CandidateReadyFact>({
        kind: 'candidateReady',
        candidateSnapshotId: 'candidate-1',
        operationId: 'operation-1'
      })
    )
    state = send(
      state,
      fact<CandidateOpenedFact>({
        kind: 'candidateOpened',
        candidateSnapshotId: 'candidate-1'
      })
    )
    state = send(state, fact<CandidateReturnedFact>({ kind: 'candidateReturned' }))
    state = send(
      state,
      fact<CandidateDiscardedFact>({
        kind: 'candidateDiscarded',
        candidateSnapshotId: 'candidate-1'
      })
    )
    expect(state.candidatePhase).toBe('discarded')
    expect(state.prompt.title).toBe('这版不用了')

    // 旧操作迟到的另一枚候选不能复活已丢弃的一版。
    state = send(
      state,
      fact<CandidateReadyFact>({
        kind: 'candidateReady',
        candidateSnapshotId: 'candidate-late',
        operationId: 'operation-1'
      })
    )
    expect(state.candidatePhase).toBe('discarded')
    expect(state.activeCandidateSnapshotId).toBeNull()

    state = send(
      state,
      fact<GenerationStartedFact>({ kind: 'generationStarted', operationId: 'operation-2' })
    )
    expect(state.candidatePhase).toBe('regenerating')
    expect(state.prompt.text).toContain('重新开始生成')

    state = send(
      state,
      fact<CandidateReadyFact>({
        kind: 'candidateReady',
        candidateSnapshotId: 'candidate-old',
        operationId: 'operation-1'
      })
    )
    expect(state.candidatePhase).toBe('regenerating')

    state = send(
      state,
      fact<CandidateReadyFact>({
        kind: 'candidateReady',
        candidateSnapshotId: 'candidate-2',
        operationId: 'operation-2'
      })
    )
    expect(state.candidatePhase).toBe('ready')
    expect(state.prompt.title).toBe('再玩一次刚才不对的地方')
    expect(state.activeCandidateSnapshotId).toBe('candidate-2')

    state = send(
      state,
      fact<CandidateOpenedFact>({
        kind: 'candidateOpened',
        candidateSnapshotId: 'candidate-2'
      })
    )
    state = send(
      state,
      fact<CandidateAcceptedFact>({
        kind: 'candidateAccepted',
        candidateSnapshotId: 'candidate-2',
        operationId: 'operation-2'
      })
    )
    expect(state.stepId).toBe('polish-dialogue')
  })

  it('候选打开时仍显示等待提示，只有用户收起才隐藏并能再展开', () => {
    let state = returnedState()
    const opened = advanceGuide(state, {
      type: 'candidate-opened',
      candidateSnapshotId: 'candidate-1'
    })
    state = opened.state
    expect(state.prompt.hidden).toBe(false)
    expect(opened.effects).toContainEqual({ type: 'overlay-shown' })

    state = advanceGuide(state, { type: 'collapse' }).state
    expect(state.prompt.hidden).toBe(true)

    state = advanceGuide(state, { type: 'expand' }).state
    expect(state.prompt.hidden).toBe(false)
    expect(state.prompt.text).toContain('正在试玩候选')

    state = advanceGuide(state, { type: 'candidate-returned' }).state
    expect(state.prompt.hidden).toBe(false)
    expect(state.prompt.tone).toBe('decision')
  })
})

describe('步骤 7：微调台词', () => {
  it('保存确认成功后先提示重开核对，用户确认后才进入导出', () => {
    let state = stateAt(GUIDE_STEP_ID.polishDialogue)
    state = send(
      state,
      fact<DialogueSaveUnsettledFact>({
        kind: 'dialogueSaveUnsettled',
        requestId: 'request-0',
        outcome: 'unverified'
      })
    )
    expect(state.stepId).toBe('polish-dialogue')
    expect(state.prompt.title).toBe('这句还不能算存好')

    state = send(state, fact<DialogueSavedFact>({ kind: 'dialogueSaved' }))
    expect([state.stepId, state.milestoneIndex]).toEqual(['polish-dialogue', 1])
    expect(state.prompt.tone).toBe('decision')
    expect(state.prompt.title).toBe('保存成功，核对新句子')
    expect(state.prompt.text).toContain('返回工作台')
    expect(state.prompt.confirmLabel).toBe('已确认改动')

    state = advanceGuide(state, { type: 'confirm-step' }).state
    expect(state.stepId).toBe('export-build')
  })

  it('保存失败或待核对显示不能算存好，确认保存后重开核对，迟到失败不覆盖', () => {
    let state = stateAt(GUIDE_STEP_ID.polishDialogue)
    state = send(
      state,
      fact<DialogueSaveUnsettledFact>({
        kind: 'dialogueSaveUnsettled',
        requestId: 'request-1',
        outcome: 'unverified'
      })
    )
    expect([state.stepId, state.milestoneIndex]).toEqual(['polish-dialogue', 0])
    expect(state.prompt.title).toBe('这句还不能算存好')
    expect(state.prompt.text).toBe('先处理预览里的保存结果。')
    expect(state.prompt.confirmLabel).toBeUndefined()

    state = send(
      state,
      fact<DialogueSaveUnsettledFact>({
        kind: 'dialogueSaveUnsettled',
        requestId: 'request-1',
        outcome: 'failed'
      })
    )
    expect([state.stepId, state.milestoneIndex]).toEqual(['polish-dialogue', 0])

    state = send(
      state,
      fact<DialogueSavedFact>({
        kind: 'dialogueSaved',
        requestId: 'request-1',
        revision: 1
      })
    )
    expect([state.stepId, state.milestoneIndex]).toEqual(['polish-dialogue', 1])
    expect(state.prompt.title).toBe('保存成功，核对新句子')

    // 已确认保存后，迟到的失败/待核对不能覆盖确认提示。
    state = send(
      state,
      fact<DialogueSaveUnsettledFact>({
        kind: 'dialogueSaveUnsettled',
        requestId: 'request-1',
        outcome: 'failed'
      })
    )
    expect([state.stepId, state.milestoneIndex]).toEqual(['polish-dialogue', 1])
    expect(state.prompt.title).toBe('保存成功，核对新句子')
  })

  it('真实未保存改词只显示保存这句改动，撤销后恢复初始并可跳过', () => {
    let state = stateAt(GUIDE_STEP_ID.polishDialogue)
    state = send(
      state,
      fact<DialogueDraftChangedFact>({ kind: 'dialogueDraftChanged', dirty: true })
    )
    expect(state.dialogueDraftDirty).toBe(true)
    expect(state.prompt.title).toBe('保存这句改动')
    expect(state.prompt.text).toContain('保存')
    expect(state.prompt.confirmLabel).toBeUndefined()
    expect(canSkipGuideStep(state, state.prompt, false)).toBe(true)

    state = send(
      state,
      fact<DialogueDraftChangedFact>({ kind: 'dialogueDraftChanged', dirty: false })
    )
    expect(state.dialogueDraftDirty).toBe(false)
    expect(state.prompt.title).toBe('在试玩预览里改一句')
    expect(canSkipGuideStep(state, state.prompt, false)).toBe(true)
  })

  it('无改动结算只恢复初始选择，不显示核对过了，迟到失败被同一请求挡住', () => {
    let state = stateAt(GUIDE_STEP_ID.polishDialogue)
    state = send(
      state,
      fact<DialogueSaveStartedFact>({ kind: 'dialogueSaveStarted', requestId: 'r-1' })
    )
    state = send(
      state,
      fact<DialogueSaveUnsettledFact>({
        kind: 'dialogueSaveUnsettled',
        requestId: 'r-1',
        outcome: 'unverified'
      })
    )
    expect(state.dialogueSaveUnresolved).toBe(true)
    expect(canSkipGuideStep(state, state.prompt, false)).toBe(false)

    state = send(
      state,
      fact<DialogueSaveClearedFact>({
        kind: 'dialogueSaveCleared',
        requestId: 'r-1',
        clearReason: 'unchanged'
      })
    )
    expect([state.stepId, state.milestoneIndex]).toEqual(['polish-dialogue', 0])
    expect(state.dialogueSaveUnresolved).toBe(false)
    expect(state.dialogueSaveResolved).toBe(true)
    expect(state.prompt.confirmLabel).toBeUndefined()
    expect(state.prompt.title).toBe('在试玩预览里改一句')
    expect(canSkipGuideStep(state, state.prompt, false)).toBe(true)

    state = send(
      state,
      fact<DialogueSaveUnsettledFact>({
        kind: 'dialogueSaveUnsettled',
        requestId: 'r-1',
        outcome: 'failed'
      })
    )
    expect(state.dialogueSaveUnresolved).toBe(false)
    expect(state.prompt.title).toBe('在试玩预览里改一句')
  })

  it('明确放弃草稿后恢复初始和跳过，不合成保存成功，迟到确认也不推进', () => {
    let state = stateAt(GUIDE_STEP_ID.polishDialogue)
    state = send(
      state,
      fact<DialogueDraftChangedFact>({ kind: 'dialogueDraftChanged', dirty: true })
    )
    state = send(
      state,
      fact<DialogueSaveStartedFact>({ kind: 'dialogueSaveStarted', requestId: 'r-1' })
    )
    state = send(
      state,
      fact<DialogueSaveUnsettledFact>({
        kind: 'dialogueSaveUnsettled',
        requestId: 'r-1',
        outcome: 'failed'
      })
    )
    state = send(
      state,
      fact<DialogueSaveClearedFact>({
        kind: 'dialogueSaveCleared',
        requestId: 'r-1',
        clearReason: 'abandoned'
      })
    )
    expect([state.stepId, state.milestoneIndex]).toEqual(['polish-dialogue', 0])
    expect(state.dialogueDraftDirty).toBe(false)
    expect(state.dialogueSaveUnresolved).toBe(false)
    expect(state.prompt.confirmLabel).toBeUndefined()
    expect(canSkipGuideStep(state, state.prompt, false)).toBe(true)

    state = send(
      state,
      fact<DialogueSavedFact>({
        kind: 'dialogueSaved',
        requestId: 'r-1',
        revision: 1
      })
    )
    expect([state.stepId, state.milestoneIndex]).toEqual(['polish-dialogue', 0])
    expect(state.prompt.confirmLabel).toBeUndefined()

    state = send(
      state,
      fact<DialogueSaveStartedFact>({ kind: 'dialogueSaveStarted', requestId: 'r-2' })
    )
    expect(state.dialogueSaveResolved).toBe(false)
    state = send(
      state,
      fact<DialogueSavedFact>({
        kind: 'dialogueSaved',
        requestId: 'r-2',
        revision: 2
      })
    )
    expect([state.stepId, state.milestoneIndex]).toEqual(['polish-dialogue', 1])
    expect(state.prompt.confirmLabel).toBe('已确认改动')
  })

  it('新请求开始后，旧请求的迟到失败与确认都不改当前提示', () => {
    let state = stateAt(GUIDE_STEP_ID.polishDialogue)
    state = send(
      state,
      fact<DialogueSaveStartedFact>({ kind: 'dialogueSaveStarted', requestId: 'r-1' })
    )
    state = send(
      state,
      fact<DialogueSaveUnsettledFact>({
        kind: 'dialogueSaveUnsettled',
        requestId: 'r-1',
        outcome: 'unverified'
      })
    )
    state = send(
      state,
      fact<DialogueSaveStartedFact>({ kind: 'dialogueSaveStarted', requestId: 'r-2' })
    )
    expect(state.dialogueSaveRequestId).toBe('r-2')
    expect(state.dialogueSaveUnresolved).toBe(false)

    state = send(
      state,
      fact<DialogueSaveUnsettledFact>({
        kind: 'dialogueSaveUnsettled',
        requestId: 'r-1',
        outcome: 'failed'
      })
    )
    expect(state.dialogueSaveUnresolved).toBe(false)

    state = send(
      state,
      fact<DialogueSaveUnsettledFact>({
        kind: 'dialogueSaveUnsettled',
        requestId: 'r-2',
        outcome: 'failed',
        scope: { ...TEST_SCOPE, sceneId: 'scene-old' }
      })
    )
    expect(state.dialogueSaveUnresolved).toBe(false)

    state = send(
      state,
      fact<DialogueSaveUnsettledFact>({
        kind: 'dialogueSaveUnsettled',
        requestId: 'r-2',
        outcome: 'failed'
      })
    )
    expect(state.dialogueSaveUnresolved).toBe(true)

    state = send(
      state,
      fact<DialogueSavedFact>({ kind: 'dialogueSaved', requestId: 'r-1', revision: 1 })
    )
    expect([state.stepId, state.milestoneIndex]).toEqual(['polish-dialogue', 0])
    expect(state.dialogueSaveUnresolved).toBe(true)

    state = send(
      state,
      fact<DialogueSavedFact>({ kind: 'dialogueSaved', requestId: 'r-2', revision: 2 })
    )
    expect([state.stepId, state.milestoneIndex]).toEqual(['polish-dialogue', 1])
    expect(state.prompt.confirmLabel).toBe('已确认改动')
  })

  it('重新进入第 7 步时清掉上一轮的保存失败与草稿状态', () => {
    let state = stateAt(GUIDE_STEP_ID.polishDialogue)
    state = send(
      state,
      fact<DialogueSaveStartedFact>({ kind: 'dialogueSaveStarted', requestId: 'r-1' })
    )
    state = send(
      state,
      fact<DialogueSaveUnsettledFact>({
        kind: 'dialogueSaveUnsettled',
        requestId: 'r-1',
        outcome: 'failed'
      })
    )
    expect(canSkipGuideStep(state, state.prompt, false)).toBe(false)

    state = advanceGuide(state, { type: 'step-selected', stepId: GUIDE_STEP_ID.exportBuild }).state
    state = advanceGuide(state, {
      type: 'step-selected',
      stepId: GUIDE_STEP_ID.polishDialogue
    }).state
    expect(state.dialogueSaveUnresolved).toBe(false)
    expect(state.dialogueSaveRequestId).toBeNull()
    expect(state.dialogueDraftDirty).toBe(false)
    expect(canSkipGuideStep(state, state.prompt, false)).toBe(true)
  })

  it('没有改词需求可以直接跳过第 7 步', () => {
    const skipped = advanceGuide(stateAt(GUIDE_STEP_ID.polishDialogue), { type: 'skip' }).state
    expect(skipped.stepId).toBe('export-build')
    expect(skipped.prompt.completion).toBe('已跳过台词微调。')
  })

  it('其他步骤不能使用跳过', () => {
    const state = stateAt(GUIDE_STEP_ID.saveAndGenerate)
    const result = advanceGuide(state, { type: 'skip' })
    expect(result.state).toBe(state)
    expect(result.effects).toEqual([])
  })
})

describe('步骤 8：导出成品', () => {
  it('导出失败显示原位失败，真正成功后才进入完成态', () => {
    let state = stateAt(GUIDE_STEP_ID.exportBuild)
    state = send(state, fact<ExportFailedFact>({ kind: 'exportFailed', outcome: 'failed' }))
    expect([state.stepId, state.milestoneIndex]).toEqual(['export-build', 0])
    expect(state.status).toBe('following')
    expect(state.prompt.title).toBe('这次没有导出成功')
    expect(state.prompt.text).toBe('按导出页的提示处理。')

    // 失败结果不能伪装成导出成功。
    state = send(state, fact<ExportedFact>({ kind: 'exported', outcome: 'failed' }))
    expect([state.stepId, state.milestoneIndex]).toEqual(['export-build', 0])
    expect(state.prompt.title).toBe('这次没有导出成功')

    const exported = advanceGuide(state, {
      type: 'fact',
      fact: fact<ExportedFact>({ kind: 'exported' })
    })
    state = exported.state
    expect(state.status).toBe('completed')
    expect(state.prompt.title).toBe('去成品里看最后一遍')
    expect(state.prompt.finishLabel).toBe('结束阅读')
    expect(state.prompt.text).toContain('打开所在文件夹')
    expect(exported.effects).toContainEqual({ type: 'guide-completed' })

    const beforeFinish = advanceGuide(state, { type: 'finish' })
    expect(beforeFinish.state.status).toBe('exited')

    const afterFinish = send(beforeFinish.state, fact<ExportedFact>({ kind: 'exported' }))
    expect(afterFinish.status).toBe('exited')

    const lateFailure = send(
      beforeFinish.state,
      fact<ExportFailedFact>({ kind: 'exportFailed', outcome: 'failed' })
    )
    expect(lateFailure.status).toBe('exited')
  })

  it('未导出也能结束阅读，只退出教程不产生导出事实', () => {
    const running = stateAt(GUIDE_STEP_ID.exportBuild)
    expect(running.prompt.title).toBe('导出刚才试玩的场景')
    const finished = advanceGuide(running, { type: 'finish' })
    expect(finished.state.status).toBe('exited')
    expect(finished.state.stepId).toBe('export-build')
    expect(isGuideTerminal(finished.state)).toBe(true)
    expect(finished.effects).toContainEqual({ type: 'guide-exited' })
    expect(finished.effects).not.toContainEqual({ type: 'guide-completed' })

    let exported = stateAt(GUIDE_STEP_ID.exportBuild)
    exported = send(exported, fact<ExportedFact>({ kind: 'exported' }))
    const done = advanceGuide(exported, { type: 'finish' })
    expect(done.state.status).toBe('exited')
    expect(isGuideTerminal(done.state)).toBe(true)
  })
})

describe('步骤查询', () => {
  it('进入、跳回和切换上下文都会推进本次练习代次', () => {
    let state = stateAt(GUIDE_STEP_ID.importScript)
    expect(state.stepAttempt).toBe(0)

    state = advanceGuide(state, {
      type: 'step-selected',
      stepId: GUIDE_STEP_ID.importScript
    }).state
    expect(state.stepAttempt).toBe(1)

    const switched = advanceGuide(state, {
      type: 'context-changed',
      scope: { projectId: 'project-2', sceneId: 'scene-2', canvasId: 'canvas-2' }
    }).state
    expect(switched.status).toBe('paused')
    const resumed = advanceGuide(switched, {
      type: 'resume',
      scope: { projectId: 'project-2', sceneId: 'scene-2', canvasId: 'canvas-2' }
    }).state
    expect(resumed.stepAttempt).toBe(2)
    expect(resumed.status).toBe('following')
  })

  it('当前里程碑随进度前进，最后一步完成前仍可查询', () => {
    let state = stateAt(GUIDE_STEP_ID.arrangeScene)
    expect(currentGuideMilestone(state)?.id).toBe('opening-placed')

    state = send(
      state,
      fact<CardCreatedFact>({ kind: 'cardCreated', cardId: 'image-1', cardKind: 'image' })
    )
    expect(currentGuideMilestone(state)?.id).toBe('opening-usage')
    expect(currentGuideMilestone(state)?.wait.kind).toBe('cardEdited')
  })
})
