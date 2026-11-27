import { describe, expect, it } from 'vitest'

import {
  advanceGuide,
  createGuideState,
  type GuideSessionState
} from '@presentation/features/beginner-guide/advanceGuide'
import { guideNavigationViewOf } from '@presentation/features/beginner-guide/guideNavigation'
import { GUIDE_STEP_ID } from '@presentation/features/beginner-guide/guideSteps'
import type {
  CardCreatedFact,
  CardDeletedFact,
  CardEditedFact,
  ConfigSavedFact,
  GuideFact,
  PromptBodySavedFact,
  RelationCreatedFact,
  RelationNamedFact
} from '@presentation/features/beginner-guide/guideObservation'
import { TEST_SCOPE, fact } from './guideFacts'

function send(state: GuideSessionState, nextFact: GuideFact): GuideSessionState {
  return advanceGuide(state, { type: 'fact', fact: nextFact }).state
}

function placed(
  state: GuideSessionState,
  cardId: string,
  cardKind: 'image' | 'audio' | 'prompt'
): GuideSessionState {
  return send(state, fact<CardCreatedFact>({ kind: 'cardCreated', cardId, cardKind }))
}

function edited(
  state: GuideSessionState,
  cardId: string,
  cardKind: 'image' | 'audio'
): GuideSessionState {
  return send(state, fact<CardEditedFact>({ kind: 'cardEdited', cardId, cardKind }))
}

function connected(
  state: GuideSessionState,
  relationId: string,
  fromCardId: string,
  fromCardKind: 'document' | 'image' | 'audio' | 'prompt',
  toCardId: string,
  toCardKind: 'document' | 'image' | 'audio' | 'prompt'
): GuideSessionState {
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
): GuideSessionState {
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

function completeArrangeBeat(
  state: GuideSessionState,
  beatNumber: number,
  scriptId = 'script-1'
): GuideSessionState {
  switch (beatNumber) {
    case 1: {
      let next = placed(state, 'image-1', 'image')
      next = edited(next, 'image-1', 'image')
      next = connected(next, 'relation-1', scriptId, 'document', 'image-1', 'image')
      return named(next, 'relation-1', scriptId, 'document', 'image-1', 'image')
    }
    case 2: {
      let next = placed(state, 'audio-1', 'audio')
      next = edited(next, 'audio-1', 'audio')
      next = connected(next, 'relation-2', 'audio-1', 'audio', 'image-1', 'image')
      return named(next, 'relation-2', 'audio-1', 'audio', 'image-1', 'image')
    }
    case 3: {
      let next = placed(state, 'image-2', 'image')
      next = edited(next, 'image-2', 'image')
      next = connected(next, 'relation-3', 'image-2', 'image', 'image-1', 'image')
      return named(next, 'relation-3', 'image-2', 'image', 'image-1', 'image')
    }
    case 4: {
      let next = placed(state, 'char-1', 'image')
      next = edited(next, 'char-1', 'image')
      next = placed(next, 'char-2', 'image')
      next = edited(next, 'char-2', 'image')
      next = connected(next, 'relation-4', 'char-1', 'image', 'char-2', 'image')
      return named(next, 'relation-4', 'char-1', 'image', 'char-2', 'image')
    }
    case 5: {
      let next = placed(state, 'audio-2', 'audio')
      next = edited(next, 'audio-2', 'audio')
      next = connected(next, 'relation-5', 'audio-2', 'audio', 'image-2', 'image')
      return named(next, 'relation-5', 'audio-2', 'audio', 'image-2', 'image')
    }
    case 6: {
      let next = placed(state, 'prompt-1', 'prompt')
      next = send(next, fact<PromptBodySavedFact>({ kind: 'promptBodySaved', cardId: 'prompt-1' }))
      next = connected(next, 'relation-6', 'prompt-1', 'prompt', scriptId, 'document')
      return named(next, 'relation-6', 'prompt-1', 'prompt', scriptId, 'document')
    }
    default:
      throw new Error(`没有第 ${beatNumber} 拍`)
  }
}

function completeArrangeThrough(state: GuideSessionState, through: number): GuideSessionState {
  let next = state
  for (let beatNumber = 1; beatNumber <= through; beatNumber += 1) {
    next = completeArrangeBeat(next, beatNumber)
  }
  return next
}

function arrangementState(): GuideSessionState {
  return createGuideState({ stepId: GUIDE_STEP_ID.arrangeScene, scope: TEST_SCOPE })
}

describe('教程上一步与下一步自由切换', () => {
  it('第 4 步第 1 拍上一步可用，回到第 3 步且不写完成记录', () => {
    const live = arrangementState()
    const view = guideNavigationViewOf(live)
    expect(view.previous.enabled).toBe(true)
    expect(view.previous.ariaLabel).toContain('第 3 步「导入剧本」')
    expect(view.next.enabled).toBe(true)

    const previous = advanceGuide(live, { type: 'go-previous' })
    expect(previous.effects).toEqual([])
    expect(previous.state.stepId).toBe(GUIDE_STEP_ID.importScript)
    expect(previous.state.milestoneIndex).toBe(0)
    expect(previous.state.completedSteps).toEqual([])
    expect(previous.state.completedBeats).toEqual([])
    expect(previous.state.prompt.title).toBe('选一段能从头读到尾的戏')
  })

  it('第 4 步第 1 拍下一步可自由到第 2 拍，再上一步回第 1 拍', () => {
    const live = arrangementState()
    const next = advanceGuide(live, { type: 'go-next' }).state
    expect(next.stepId).toBe(GUIDE_STEP_ID.arrangeScene)
    expect(next.milestoneIndex).toBe(4)
    expect(next.prompt.title).toBe('先让玩家听见')
    expect(next.prompt.text).toContain('短声音')
    expect(next.completedBeats).toEqual([])

    const back = advanceGuide(next, { type: 'go-previous' }).state
    expect(back.milestoneIndex).toBe(0)
    expect(back.prompt.title).toBe('添加场景背景图')
    expect(back.completedBeats).toEqual([])
  })

  it('跳过未完成步骤只移动位置，之后回来仍从未完成开头显示', () => {
    let live = createGuideState({ scope: TEST_SCOPE })
    live = send(live, fact<ConfigSavedFact>({ kind: 'configSaved', configFingerprint: 'fp-1' }))
    expect(live.milestoneIndex).toBe(1)

    const next = advanceGuide(live, { type: 'go-next' }).state
    expect(next.stepId).toBe(GUIDE_STEP_ID.createProject)
    expect(next.milestoneIndex).toBe(0)
    expect(next.completedSteps).toEqual([])

    const back = advanceGuide(next, { type: 'go-previous' }).state
    expect(back.stepId).toBe(GUIDE_STEP_ID.configureModel)
    expect(back.milestoneIndex).toBe(0)
    expect(back.completedSteps).toEqual([])
    expect(back.prompt.title).toBe('先接通一个模型')
  })

  it('第一步上一步禁用，最后一步下一步禁用', () => {
    const first = createGuideState({ scope: TEST_SCOPE })
    expect(guideNavigationViewOf(first).previous.enabled).toBe(false)
    expect(guideNavigationViewOf(first).next.enabled).toBe(true)

    const last = createGuideState({ stepId: GUIDE_STEP_ID.exportBuild, scope: TEST_SCOPE })
    expect(guideNavigationViewOf(last).previous.enabled).toBe(true)
    expect(guideNavigationViewOf(last).next.enabled).toBe(false)
    expect(guideNavigationViewOf(last).next.ariaLabel).toContain('已经是最后一步')
  })

  it('拍导航不清理真实完成记录，也不补写未完成拍', () => {
    const live = completeArrangeThrough(arrangementState(), 2)
    expect(live.completedBeats).toEqual(['opening', 'cue'])
    expect(live.milestoneIndex).toBe(8)

    const beatTwo = advanceGuide(live, { type: 'go-previous' }).state
    expect(beatTwo.milestoneIndex).toBe(4)
    expect(beatTwo.completedBeats).toEqual(['opening', 'cue'])
    expect(beatTwo.prompt.title).toBe('先让玩家听见')

    const beatOne = advanceGuide(beatTwo, { type: 'go-previous' }).state
    expect(beatOne.milestoneIndex).toBe(0)
    expect(beatOne.completedBeats).toEqual(['opening', 'cue'])

    const skipForward = advanceGuide(beatOne, { type: 'go-next' }).state
    expect(skipForward.milestoneIndex).toBe(4)
    expect(skipForward.completedBeats).toEqual(['opening', 'cue'])
  })

  it('删除已绑定卡会让对应拍之后的完成记录失效', () => {
    let live = completeArrangeThrough(arrangementState(), 2)
    live = send(
      live,
      fact<CardDeletedFact>({ kind: 'cardDeleted', cardId: 'image-1', cardKind: 'image' })
    )
    expect(live.completedBeats).toEqual([])
    expect(live.milestoneIndex).toBe(0)
    expect(guideNavigationViewOf(live).previous.enabled).toBe(true)
    expect(guideNavigationViewOf(live).previous.ariaLabel).toContain('第 3 步')
  })

  it('六拍完成后下一步到第 5 步不替用户确认完成', () => {
    const live = completeArrangeThrough(arrangementState(), 6)
    expect(live.completedBeats).toEqual([
      'opening',
      'cue',
      'scene-change',
      'character',
      'music',
      'ending'
    ])
    expect(live.completedSteps).toEqual([])

    const next = advanceGuide(live, { type: 'go-next' }).state
    expect(next.stepId).toBe(GUIDE_STEP_ID.saveAndGenerate)
    expect(next.milestoneIndex).toBe(0)
    expect(next.completedSteps).toEqual([])
    expect(next.completedBeats).toEqual([
      'opening',
      'cue',
      'scene-change',
      'character',
      'music',
      'ending'
    ])

    const back = advanceGuide(next, { type: 'go-previous' }).state
    expect(back.stepId).toBe(GUIDE_STEP_ID.arrangeScene)
    expect(back.prompt.title).toBe('约定收尾')
    expect(back.completedSteps).toEqual([])
  })

  it('任意步骤都能靠上一步/下一步到达，跳转不写完成记录', () => {
    let state = createGuideState({ scope: TEST_SCOPE })
    const forward: string[] = [state.stepId]
    let guard = 0
    while (state.stepId !== GUIDE_STEP_ID.exportBuild && guard < 20) {
      state = advanceGuide(state, { type: 'go-next' }).state
      forward.push(state.stepId)
      guard += 1
    }
    expect(state.stepId).toBe(GUIDE_STEP_ID.exportBuild)
    expect(forward).toContain(GUIDE_STEP_ID.arrangeScene)
    expect(forward).toContain(GUIDE_STEP_ID.playtestCandidate)
    expect(state.completedSteps).toEqual([])
    expect(state.completedBeats).toEqual([])

    const backward: string[] = [state.stepId]
    guard = 0
    while (state.stepId !== GUIDE_STEP_ID.configureModel && guard < 20) {
      state = advanceGuide(state, { type: 'go-previous' }).state
      backward.push(state.stepId)
      guard += 1
    }
    expect(state.stepId).toBe(GUIDE_STEP_ID.configureModel)
    expect(backward).toContain(GUIDE_STEP_ID.exportBuild)
    expect(state.completedSteps).toEqual([])
    expect(state.completedBeats).toEqual([])
  })

  it('恢复第 4 步编排拍只恢复位置，不补完成记录', () => {
    const restored = createGuideState({
      stepId: GUIDE_STEP_ID.arrangeScene,
      beatId: 'cue',
      scope: TEST_SCOPE
    })
    expect(restored.milestoneIndex).toBe(4)
    expect(restored.prompt.title).toBe('先让玩家听见')
    expect(restored.completedBeats).toEqual([])
    expect(restored.completedSteps).toEqual([])
  })
})
