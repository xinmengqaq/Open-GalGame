import { describe, expect, it } from 'vitest'

import type { SceneGenerationRenderStatusVO } from '@application/scene-generation/vo/SceneGenerationRenderVO'
import type { CandidatePreviewVO } from '@application/scene-preview/vo/CandidatePreviewVO'
import type { CandidatePreviewEventVO } from '@interfaces/scene-preview/contracts/ScenePreviewResponseSchema'
import {
  gameStageEventOfCandidate,
  type GameStageEvent,
  type GameStageEventIdentity
} from '@presentation/features/game-stage/gameStageEvents'
import {
  candidateOpeningStallMs,
  candidatePreviewPhaseOf,
  candidatePreviewReducer,
  candidatePreviewTargetKey,
  candidatePreviewTargetOf,
  candidateShortId,
  initialCandidatePreviewState,
  isCandidateSessionRejection,
  type CandidatePreviewAction,
  type CandidatePreviewState,
  type CandidatePreviewTarget
} from '@presentation/pages/workbench/drawer/candidate/candidatePreviewState'

const target: CandidatePreviewTarget = {
  projectId: 'project-1',
  sceneId: 'scene-1',
  operationId: 'operation-1',
  threadId: 'thread-1',
  branchId: 'branch-1',
  checkpointId: 'checkpoint-1',
  candidateSnapshotId: '0123456789abcdef'
}

const expiresAt = Date.parse('2026-10-26T12:15:00.000Z')

function status(
  overrides: Partial<SceneGenerationRenderStatusVO> = {}
): SceneGenerationRenderStatusVO {
  return {
    projectId: 'project-1',
    sceneId: 'scene-1',
    operationId: 'operation-1',
    threadId: 'thread-1',
    branchId: 'branch-1',
    checkpointId: 'checkpoint-1',
    state: 'waiting',
    stage: 'waitingReview',
    stageMessage: '等待你审阅候选',
    attempt: 1,
    sequence: 12,
    canPause: false,
    canResume: false,
    canCancel: true,
    inputSummary: {
      canvasId: 'canvas-1',
      arrangementVersion: 'version-1',
      documentCount: 1,
      assetCount: 1,
      promptCount: 1,
      fieldBindingCount: 0,
      relationCount: 0,
      confirmedControlCount: 0
    },
    usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30, tokenLimit: null },
    candidateSnapshotId: '0123456789abcdef',
    previewAvailable: true,
    interaction: {
      interactionId: 'interaction-1',
      checkpointId: 'checkpoint-1',
      kind: 'review',
      message: '候选已经生成，请审阅。',
      options: [],
      allowedReplies: ['accept', 'revise', 'discard'],
      candidateSnapshotId: '0123456789abcdef'
    },
    ...overrides
  }
}

function preview(overrides: Partial<CandidatePreviewVO> = {}): CandidatePreviewVO {
  return {
    projectId: 'project-1',
    sceneId: 'scene-1',
    sceneName: '雨夜重逢',
    readOnly: true,
    candidate: {
      previewSessionId: 'session-1',
      candidateSnapshotId: '0123456789abcdef',
      expiresAt: '2026-10-26T12:15:00.000Z'
    },
    contentBasis: {
      digest: 'digest-1',
      parserVersion: 'parser-1',
      engineVersion: 'engine-1'
    },
    issues: [
      { message: '缺少背景素材', assetName: 'sora_01.jpg' },
      { message: '有一句旁白没有角色名' }
    ],
    ...overrides
  }
}

const expectedIdentity = {
  projectId: 'project-1',
  sceneId: 'scene-1',
  previewSessionId: 'session-1',
  candidateSnapshotId: '0123456789abcdef'
}

function event(
  sequence: number,
  type: CandidatePreviewEventVO['type'],
  overrides: Partial<CandidatePreviewEventVO> = {}
): GameStageEvent {
  const identity = {
    sequence,
    projectId: 'project-1',
    sceneId: 'scene-1',
    previewSessionId: 'session-1',
    candidateSnapshotId: '0123456789abcdef'
  }
  const raw =
    type === 'invalidated'
      ? ({ type, ...identity, ...overrides } as CandidatePreviewEventVO)
      : ({
          type,
          ...identity,
          message: type === 'ready' ? '游戏已就绪' : '游戏加载失败',
          ...overrides
        } as CandidatePreviewEventVO)
  const mapped = gameStageEventOfCandidate(raw, expectedIdentity)
  if (mapped === null) throw new Error('测试事件没有通过候选身份核对')
  return mapped
}

/** 绕过共享适配口的身份过滤，单独验证状态机自己的防御。 */
function eventWithIdentity(
  sequence: number,
  type: CandidatePreviewEventVO['type'],
  identity: Partial<GameStageEventIdentity>
): GameStageEvent {
  const mapped = event(sequence, type)
  return { ...mapped, identity: { ...mapped.identity, ...identity } }
}

function reduce(
  actions: readonly CandidatePreviewAction[],
  initial: CandidatePreviewState = initialCandidatePreviewState
): CandidatePreviewState {
  return actions.reduce(candidatePreviewReducer, initial)
}

function openedState(): CandidatePreviewState {
  return reduce([
    {
      type: 'start',
      projectId: 'project-1',
      sceneId: 'scene-1',
      candidateSnapshotId: '0123456789abcdef'
    },
    {
      type: 'opened',
      projectId: 'project-1',
      sceneId: 'scene-1',
      sessionId: 'session-1',
      candidateSnapshotId: '0123456789abcdef',
      stageUrl: 'http://127.0.0.1:41000/?session=session-1',
      expiresAt
    }
  ])
}

function readyState(): CandidatePreviewState {
  return reduce(
    [
      { type: 'read-started' },
      { type: 'read-succeeded', preview: preview() },
      { type: 'event', event: event(1, 'ready') }
    ],
    openedState()
  )
}

describe('candidatePreviewTargetOf', () => {
  it('只从可预览的审阅交互取固定候选和检查点', () => {
    expect(candidatePreviewTargetOf(status())).toEqual(target)
  })

  it('交互未带候选时回退到状态投影的同一候选', () => {
    const interaction = status().interaction!
    const result = candidatePreviewTargetOf(
      status({
        interaction: { ...interaction, candidateSnapshotId: undefined },
        checkpointId: 'checkpoint-1'
      })
    )
    expect(result?.candidateSnapshotId).toBe('0123456789abcdef')
  })

  it('没有预览授权、没有交互、没有候选或非审阅交互时不产生目标', () => {
    expect(candidatePreviewTargetOf(null)).toBeNull()
    expect(candidatePreviewTargetOf(status({ previewAvailable: false }))).toBeNull()
    expect(candidatePreviewTargetOf(status({ interaction: undefined }))).toBeNull()
    expect(
      candidatePreviewTargetOf(
        status({
          candidateSnapshotId: undefined,
          interaction: {
            ...status().interaction!,
            kind: 'decision',
            candidateSnapshotId: undefined
          }
        })
      )
    ).toBeNull()
  })

  it('审阅交互的检查点或候选与当前状态不一致时不按过期身份打开', () => {
    const interaction = status().interaction!

    expect(
      candidatePreviewTargetOf(
        status({ interaction: { ...interaction, checkpointId: 'checkpoint-old' } })
      )
    ).toBeNull()
    expect(
      candidatePreviewTargetOf(
        status({ interaction: { ...interaction, candidateSnapshotId: 'candidate-old' } })
      )
    ).toBeNull()
  })

  it('目标键包含候选、检查点和完整生成范围', () => {
    expect(candidatePreviewTargetKey(target)).toContain('0123456789abcdef')
    expect(candidatePreviewTargetKey(target)).toContain('checkpoint-1')
    expect(candidatePreviewTargetKey({ ...target, threadId: 'thread-2' })).not.toBe(
      candidatePreviewTargetKey(target)
    )
  })

  it('失败或取消后授权只读时，不要求交互也能产生同一只读目标', () => {
    const failed = status({
      state: 'failed',
      stage: 'failed',
      stageMessage: '本次生成未完成',
      canCancel: false,
      interaction: undefined,
      previewAuthorization: 'readOnly'
    })
    const cancelled = status({
      ...failed,
      state: 'cancelled',
      stage: 'cancelled',
      stageMessage: '生成已取消'
    })

    expect(candidatePreviewTargetOf(failed)).toEqual(target)
    expect(candidatePreviewTargetOf(cancelled)).toEqual(target)
  })

  it('失败后残留非审阅交互时仍按只读授权取完整候选身份', () => {
    const interaction = status().interaction!
    const failed = status({
      state: 'failed',
      stage: 'failed',
      interaction: { ...interaction, kind: 'decision', options: [], allowedReplies: ['select'] },
      previewAuthorization: 'readOnly'
    })

    expect(candidatePreviewTargetOf(failed)).toEqual(target)
  })

  it('失败终态缺少只读授权时不从残留审阅交互推断', () => {
    expect(
      candidatePreviewTargetOf(
        status({
          state: 'failed',
          stage: 'failed',
          previewAuthorization: undefined
        })
      )
    ).toBeNull()
  })

  it('待核对中断有只读授权和完整候选身份时，不要求交互也能产生同一只读目标', () => {
    const interrupted = status({
      state: 'interrupted',
      stage: 'waitingReview',
      stageMessage: '提交结果待核对',
      canCancel: false,
      interaction: undefined,
      previewAuthorization: 'readOnly'
    })

    expect(candidatePreviewTargetOf(interrupted)).toEqual(target)
  })

  it('待核对中断缺少只读授权、候选或检查点时仍不产生目标', () => {
    const interrupted = status({
      state: 'interrupted',
      stage: 'generating',
      interaction: undefined,
      previewAuthorization: 'readOnly'
    })

    expect(candidatePreviewTargetOf({ ...interrupted, previewAuthorization: undefined })).toBeNull()
    expect(
      candidatePreviewTargetOf({ ...interrupted, previewAuthorization: 'unavailable' })
    ).toBeNull()
    expect(candidatePreviewTargetOf({ ...interrupted, previewAvailable: false })).toBeNull()
    expect(candidatePreviewTargetOf({ ...interrupted, candidateSnapshotId: undefined })).toBeNull()
    expect(candidatePreviewTargetOf({ ...interrupted, checkpointId: undefined })).toBeNull()
  })

  it('暂停中断不按只读终态授予候选，仍只认审阅或修正交互', () => {
    const paused = status({
      state: 'interrupted',
      stage: 'paused',
      interaction: undefined,
      previewAuthorization: 'readOnly'
    })

    expect(candidatePreviewTargetOf(paused)).toBeNull()
  })

  it('失败后未授权、候选不可预览或缺身份时不产生目标', () => {
    const failed = status({
      state: 'failed',
      stage: 'failed',
      interaction: undefined,
      previewAuthorization: 'readOnly'
    })

    expect(candidatePreviewTargetOf({ ...failed, previewAuthorization: 'unavailable' })).toBeNull()
    expect(candidatePreviewTargetOf({ ...failed, previewAvailable: false })).toBeNull()
    expect(candidatePreviewTargetOf({ ...failed, candidateSnapshotId: undefined })).toBeNull()
    expect(candidatePreviewTargetOf({ ...failed, checkpointId: undefined })).toBeNull()
  })

  it('进行中的记录即使带只读授权也不产生目标', () => {
    expect(
      candidatePreviewTargetOf(
        status({
          state: 'waiting',
          interaction: undefined,
          previewAuthorization: 'readOnly'
        })
      )
    ).toBeNull()
  })
})

describe('candidatePreviewReducer', () => {
  it('打开后读取成功进入就绪，并只公开短候选标识', () => {
    const state = readyState()

    expect(candidatePreviewPhaseOf(state)).toBe('ready')
    expect(state.read).toBe('ready')
    expect(state.sceneName).toBe('雨夜重逢')
    expect(state.issues).toHaveLength(2)
    expect(candidateShortId(state.candidateSnapshotId)).toBe('01234567')
    expect(candidateShortId(null)).toBeNull()
  })

  it('打开返回后、读取完成前到达的 ready 不被丢弃', () => {
    const state = reduce(
      [{ type: 'event', event: event(1, 'ready') }, { type: 'read-started' }],
      openedState()
    )

    expect(state.stage).toBe('ready')
    expect(candidatePreviewPhaseOf(state)).toBe('ready')
  })

  it('会话和候选不匹配的舞台事件被丢弃', () => {
    const base = openedState()
    const wrongSession = reduce(
      [{ type: 'event', event: eventWithIdentity(1, 'ready', { previewSessionId: 'session-2' }) }],
      base
    )
    const wrongCandidate = reduce(
      [
        {
          type: 'event',
          event: eventWithIdentity(1, 'ready', { candidateSnapshotId: 'candidate-other' })
        }
      ],
      base
    )
    const wrongScene = reduce(
      [{ type: 'event', event: eventWithIdentity(1, 'ready', { sceneId: 'scene-2' }) }],
      base
    )

    expect(wrongSession.stage).toBe('idle')
    expect(wrongCandidate.stage).toBe('idle')
    expect(wrongScene.stage).toBe('idle')
  })

  it('未打开或没有会话时的舞台事件不改变状态', () => {
    const opening = reduce([
      {
        type: 'start',
        projectId: 'project-1',
        sceneId: 'scene-1',
        candidateSnapshotId: '0123456789abcdef'
      }
    ])
    expect(candidatePreviewReducer(opening, { type: 'event', event: event(1, 'ready') })).toBe(
      opening
    )
  })

  it('按序号丢弃迟到的旧事件，较新的失效覆盖就绪', () => {
    const ready = reduce([{ type: 'event', event: event(2, 'ready') }], openedState())
    const lateFailure = reduce([{ type: 'event', event: event(1, 'stageFailed') }], ready)
    expect(lateFailure.stage).toBe('ready')

    const invalidated = reduce([{ type: 'event', event: event(3, 'invalidated') }], ready)
    expect(candidatePreviewPhaseOf(invalidated)).toBe('invalidated')
    expect(invalidated.stageUrl).toBeNull()
    expect(invalidated.issues).toEqual([])
    expect(invalidated.read).toBe('idle')

    const lateReady = reduce([{ type: 'event', event: event(2, 'ready') }], invalidated)
    expect(lateReady).toBe(invalidated)
  })

  it('失效后的读取成功或舞台就绪不会覆盖清空结果', () => {
    const state = reduce([{ type: 'event', event: event(2, 'invalidated') }], readyState())

    const afterRead = candidatePreviewReducer(state, {
      type: 'read-succeeded',
      preview: preview()
    })
    const afterReady = candidatePreviewReducer(state, { type: 'event', event: event(3, 'ready') })

    expect(afterRead).toBe(state)
    expect(afterReady).toBe(state)
  })

  it('读取失败清空问题并卸载画面；同一会话重读成功后恢复舞台状态', () => {
    const ready = readyState()
    const failed = reduce(
      [{ type: 'read-failed', message: '候选预览暂时不可用', sessionRejected: false }],
      ready
    )

    expect(candidatePreviewPhaseOf(failed)).toBe('read-failed')
    expect(failed.issues).toEqual([])
    expect(failed.stage).toBe('ready')

    const recovered = reduce(
      [{ type: 'read-started' }, { type: 'read-succeeded', preview: preview() }],
      failed
    )
    expect(candidatePreviewPhaseOf(recovered)).toBe('ready')
    expect(recovered.issues).toHaveLength(2)
  })

  it('运行会话被拒绝时只关闭舞台，候选内容和问题保留', () => {
    const expired = reduce(
      [{ type: 'read-failed', message: '候选预览会话已过期', sessionRejected: true }],
      readyState()
    )

    expect(candidatePreviewPhaseOf(expired)).toBe('expired')
    expect(expired.stageUrl).toBeNull()
    expect(expired.sceneName).toBe('雨夜重逢')
    expect(expired.issues).toHaveLength(2)
    expect(expired.issues).toEqual(readyState().issues)
    expect(expired.sessionId).toBe('session-1')

    expect(candidatePreviewReducer(expired, { type: 'event', event: event(9, 'ready') })).toBe(
      expired
    )
  })

  it('读取中会话过期后回到未读取，候选身份仍保留', () => {
    const loading = reduce([{ type: 'read-started' }], openedState())
    const expired = candidatePreviewReducer(loading, { type: 'expire' })

    expect(candidatePreviewPhaseOf(expired)).toBe('expired')
    expect(expired.read).toBe('idle')
    expect(expired.readMessage).toBeNull()
    expect(expired.candidateSnapshotId).toBe('0123456789abcdef')
    expect(expired.stageUrl).toBeNull()
  })

  it('读取失败会话过期后不残留失败说明，也不显示读取中', () => {
    const failed = reduce(
      [{ type: 'read-failed', message: '候选预览暂时不可用', sessionRejected: false }],
      openedState()
    )

    expect(failed.read).toBe('failed')
    expect(failed.readMessage).toBe('候选预览暂时不可用')

    const expired = candidatePreviewReducer(failed, { type: 'expire' })
    expect(expired.read).toBe('idle')
    expect(expired.readMessage).toBeNull()
    expect(candidatePreviewPhaseOf(expired)).toBe('expired')
  })

  it('已读完成的内容在会话过期后仍作为审阅依据保留', () => {
    const expired = reduce([{ type: 'expire' }], readyState())

    expect(expired.read).toBe('ready')
    expect(expired.issues).toHaveLength(2)
    expect(expired.readMessage).toBeNull()
  })

  it('读取中收到会话拒绝时同样清掉读取中状态', () => {
    const loading = reduce([{ type: 'read-started' }], openedState())
    const expired = candidatePreviewReducer(loading, {
      type: 'read-failed',
      message: '候选预览会话已过期',
      sessionRejected: true
    })

    expect(candidatePreviewPhaseOf(expired)).toBe('expired')
    expect(expired.read).toBe('idle')
    expect(expired.readMessage).toBeNull()
  })

  it('运行会话到期只卸载画面，迟到的失效、就绪和读取结果都不覆盖候选依据', () => {
    const expired = reduce([{ type: 'expire' }], readyState())
    expect(candidatePreviewPhaseOf(expired)).toBe('expired')
    expect(expired.stageUrl).toBeNull()
    expect(expired.sceneName).toBe('雨夜重逢')
    expect(expired.issues).toHaveLength(2)
    expect(expired.candidateSnapshotId).toBe('0123456789abcdef')

    expect(candidatePreviewReducer(expired, { type: 'read-succeeded', preview: preview() })).toBe(
      expired
    )
    expect(
      candidatePreviewReducer(expired, {
        type: 'read-failed',
        message: '候选预览暂时不可用',
        sessionRejected: false
      })
    ).toBe(expired)
    expect(candidatePreviewReducer(expired, { type: 'event', event: event(9, 'ready') })).toBe(
      expired
    )
    expect(
      candidatePreviewReducer(expired, { type: 'event', event: event(10, 'invalidated') })
    ).toBe(expired)
  })

  it('同一候选运行到期后重开回到新运行会话，旧会话事件不覆盖新画面', () => {
    const expired = reduce([{ type: 'expire' }], readyState())
    const reopening = candidatePreviewReducer(expired, {
      type: 'start',
      projectId: 'project-1',
      sceneId: 'scene-1',
      candidateSnapshotId: '0123456789abcdef'
    })

    expect(reopening.lifecycle).toBe('opening')
    expect(reopening.sessionId).toBeNull()
    expect(reopening.issues).toEqual(expired.issues)
    expect(reopening.sceneName).toBe('雨夜重逢')

    const openedAgain = candidatePreviewReducer(reopening, {
      type: 'opened',
      projectId: 'project-1',
      sceneId: 'scene-1',
      sessionId: 'session-2',
      candidateSnapshotId: '0123456789abcdef',
      stageUrl: 'http://127.0.0.1:9/stage',
      expiresAt: Date.now() + 900_000
    })
    expect(openedAgain.lifecycle).toBe('open')
    expect(candidatePreviewReducer(openedAgain, { type: 'event', event: event(9, 'ready') })).toBe(
      openedAgain
    )
    const readyAgain = candidatePreviewReducer(openedAgain, {
      type: 'event',
      event: eventWithIdentity(1, 'ready', { previewSessionId: 'session-2' })
    })
    expect(candidatePreviewPhaseOf(readyAgain)).toBe('ready')
  })

  it('读取结果和问题更新不改变舞台地址或画面实例，避免重新启动 BGM', () => {
    const ready = readyState()
    const reread = reduce(
      [
        { type: 'read-started' },
        { type: 'read-succeeded', preview: preview({ issues: [] }) },
        { type: 'read-failed', message: '候选预览暂时不可用', sessionRejected: false }
      ],
      ready
    )

    expect(reread.stageUrl).toBe(ready.stageUrl)
    expect(reread.frameToken).toBe(ready.frameToken)
    expect(reread.sessionId).toBe(ready.sessionId)
  })

  it('重新载入画面只重建同一会话的舞台，不改变候选、读取结果或问题', () => {
    const ready = readyState()
    const reloaded = candidatePreviewReducer(ready, { type: 'reload-stage' })

    expect(reloaded.frameToken).toBe(ready.frameToken + 1)
    expect(reloaded.lifecycle).toBe('open')
    expect(reloaded.sessionId).toBe(ready.sessionId)
    expect(reloaded.stageUrl).toBe(ready.stageUrl)
    expect(reloaded.stage).toBe('ready')
    expect(reloaded.issues).toEqual(ready.issues)
    expect(candidatePreviewPhaseOf(reloaded)).toBe('ready')
  })

  it('只有已打开且取得舞台地址时才能重新载入，新会话重置计数', () => {
    const opening = reduce([
      {
        type: 'start',
        projectId: 'project-1',
        sceneId: 'scene-1',
        candidateSnapshotId: '0123456789abcdef'
      }
    ])
    const expired = reduce([{ type: 'expire' }], readyState())
    const noStage = { ...readyState(), stageUrl: null }

    expect(candidatePreviewReducer(opening, { type: 'reload-stage' })).toBe(opening)
    expect(candidatePreviewReducer(expired, { type: 'reload-stage' })).toBe(expired)
    expect(candidatePreviewReducer(noStage, { type: 'reload-stage' })).toBe(noStage)

    const reloaded = candidatePreviewReducer(readyState(), { type: 'reload-stage' })
    const restarted = candidatePreviewReducer(reloaded, {
      type: 'start',
      projectId: 'project-1',
      sceneId: 'scene-1',
      candidateSnapshotId: '0123456789abcdef'
    })
    expect(restarted.frameToken).toBe(0)
  })

  it('读取结果必须匹配会话、候选和工程场景，且保持只读', () => {
    const base = openedState()
    const wrongSession = reduce(
      [
        {
          type: 'read-succeeded',
          preview: preview({ candidate: { ...preview().candidate, previewSessionId: 'session-2' } })
        }
      ],
      base
    )
    const wrongProject = reduce(
      [{ type: 'read-succeeded', preview: preview({ projectId: 'project-2' }) }],
      base
    )
    const notReadOnly = reduce(
      [{ type: 'read-succeeded', preview: { ...preview(), readOnly: false as true } }],
      base
    )

    expect(wrongSession.read).toBe('idle')
    expect(wrongProject.read).toBe('idle')
    expect(notReadOnly.read).toBe('idle')
  })

  it('同一候选重新运行会换新会话并保留候选依据', () => {
    const started = reduce(
      [
        {
          type: 'start',
          projectId: 'project-1',
          sceneId: 'scene-1',
          candidateSnapshotId: '0123456789abcdef'
        }
      ],
      readyState()
    )

    expect(candidatePreviewPhaseOf(started)).toBe('opening')
    expect(started.stageUrl).toBeNull()
    expect(started.issues).toHaveLength(2)
    expect(started.sceneName).toBe('雨夜重逢')
    expect(started.sessionId).toBeNull()
    expect(started.candidateSnapshotId).toBe('0123456789abcdef')

    const reopened = candidatePreviewReducer(started, {
      type: 'opened',
      projectId: 'project-1',
      sceneId: 'scene-1',
      sessionId: 'session-2',
      candidateSnapshotId: '0123456789abcdef',
      stageUrl: 'http://127.0.0.1:41000/?session=session-2',
      expiresAt: Date.now() + 60_000
    })
    expect(reopened.sessionId).toBe('session-2')
    expect(reopened.issues).toHaveLength(2)
    expect(reopened.stageUrl).toContain('session-2')
  })

  it('切换到别的候选时清空旧候选依据', () => {
    const started = reduce(
      [
        {
          type: 'start',
          projectId: 'project-1',
          sceneId: 'scene-1',
          candidateSnapshotId: 'candidate-other'
        }
      ],
      readyState()
    )

    expect(started.issues).toEqual([])
    expect(started.sceneName).toBeNull()
    expect(started.candidateSnapshotId).toBe('candidate-other')
  })

  it('打开失败和不支持分别进入独立状态', () => {
    const opening = reduce([
      {
        type: 'start',
        projectId: 'project-1',
        sceneId: 'scene-1',
        candidateSnapshotId: '0123456789abcdef'
      }
    ])
    const failed = candidatePreviewReducer(opening, {
      type: 'open-failed',
      message: '候选修订未发布',
      unsupported: false
    })
    const unsupported = candidatePreviewReducer(opening, {
      type: 'open-failed',
      message: '当前环境不支持场景预览',
      unsupported: true
    })

    expect(candidatePreviewPhaseOf(failed)).toBe('failed')
    expect(candidatePreviewPhaseOf(unsupported)).toBe('unsupported')
    expect(failed.candidateSnapshotId).toBe('0123456789abcdef')
    expect(unsupported.candidateSnapshotId).toBe('0123456789abcdef')
  })

  it('舞台失败保留安全原因，未映射文本不进入状态', () => {
    const failed = reduce(
      [{ type: 'event', event: event(1, 'stageFailed', { message: '宿主无法开始游戏' }) }],
      openedState()
    )
    expect(candidatePreviewPhaseOf(failed)).toBe('stage-failed')
    expect(failed.stageFailureMessage).toBe('宿主无法开始游戏')
    expect(failed.failureMessage).toBeNull()

    const unmapped = reduce(
      [
        {
          type: 'event',
          event: event(1, 'stageFailed', {
            message: 'Error: ECONNREFUSED D:/secret/game.txt at start (stack)'
          })
        }
      ],
      openedState()
    )
    expect(unmapped.stage).toBe('failed')
    expect(unmapped.stageFailureMessage).toBeNull()
  })

  it('重新打开、切换候选、过期或关闭后不残留旧舞台失败原因', () => {
    const failed = reduce(
      [{ type: 'event', event: event(1, 'stageFailed', { message: '游戏加载超时' }) }],
      openedState()
    )
    const restarted = reduce(
      [
        {
          type: 'start',
          projectId: 'project-1',
          sceneId: 'scene-1',
          candidateSnapshotId: '0123456789abcdef'
        }
      ],
      failed
    )
    expect(restarted.stageFailureMessage).toBeNull()

    const switched = reduce(
      [
        {
          type: 'start',
          projectId: 'project-1',
          sceneId: 'scene-1',
          candidateSnapshotId: 'candidate-other'
        }
      ],
      failed
    )
    expect(switched.stageFailureMessage).toBeNull()

    const expired = reduce([{ type: 'expire' }], failed)
    expect(expired.stageFailureMessage).toBeNull()
    expect(expired.failureMessage).toBeNull()

    const invalidated = reduce([{ type: 'event', event: event(2, 'invalidated') }], failed)
    expect(invalidated.stageFailureMessage).toBeNull()

    const reopened = reduce(
      [
        {
          type: 'start',
          projectId: 'project-1',
          sceneId: 'scene-1',
          candidateSnapshotId: '0123456789abcdef'
        },
        {
          type: 'opened',
          projectId: 'project-1',
          sceneId: 'scene-1',
          sessionId: 'session-2',
          candidateSnapshotId: '0123456789abcdef',
          stageUrl: 'http://127.0.0.1:9/stage',
          expiresAt: Date.now() + 60_000
        }
      ],
      failed
    )
    expect(reopened.stageFailureMessage).toBeNull()
    const stale = candidatePreviewReducer(reopened, {
      type: 'event',
      event: event(1, 'stageFailed', { message: '游戏加载超时' })
    })
    expect(stale).toBe(reopened)
    expect(stale.stageFailureMessage).toBeNull()
  })
})

describe('opening 安全阈值', () => {
  it('冻结阈值为 15 秒', () => {
    expect(candidateOpeningStallMs).toBe(15_000)
  })

  it('打开请求未返回时超时只标记等待较久，不改阶段或候选身份', () => {
    const opening = reduce([
      {
        type: 'start',
        projectId: 'project-1',
        sceneId: 'scene-1',
        candidateSnapshotId: '0123456789abcdef'
      }
    ])
    const stalled = candidatePreviewReducer(opening, { type: 'opening-stalled' })

    expect(stalled.openingStalled).toBe(true)
    expect(candidatePreviewPhaseOf(stalled)).toBe('opening')
    expect(stalled.candidateSnapshotId).toBe('0123456789abcdef')
    expect(stalled.sessionId).toBeNull()
    expect(candidatePreviewReducer(stalled, { type: 'opening-stalled' })).toBe(stalled)
  })

  it('打开返回后等待画面就绪仍属于 opening，可以进入等待较久', () => {
    const stalled = candidatePreviewReducer(openedState(), { type: 'opening-stalled' })

    expect(stalled.openingStalled).toBe(true)
    expect(candidatePreviewPhaseOf(stalled)).toBe('opening')
    expect(stalled.sessionId).toBe('session-1')
    expect(stalled.stageUrl).toBe(openedState().stageUrl)
  })

  it('就绪、读取失败和打开失败都不会被误标为等待较久', () => {
    const ready = readyState()
    const readFailed = reduce(
      [{ type: 'read-failed', message: '候选预览暂时不可用', sessionRejected: false }],
      openedState()
    )
    const openFailed = reduce([
      {
        type: 'start',
        projectId: 'project-1',
        sceneId: 'scene-1',
        candidateSnapshotId: '0123456789abcdef'
      },
      { type: 'open-failed', message: '候选修订未发布', unsupported: false }
    ])

    expect(candidatePreviewReducer(ready, { type: 'opening-stalled' })).toBe(ready)
    expect(candidatePreviewReducer(readFailed, { type: 'opening-stalled' })).toBe(readFailed)
    expect(candidatePreviewReducer(openFailed, { type: 'opening-stalled' })).toBe(openFailed)
  })

  it('重新打开会清掉等待较久标记并重新计时', () => {
    const stalled = candidatePreviewReducer(openedState(), { type: 'opening-stalled' })
    const restarted = candidatePreviewReducer(stalled, {
      type: 'start',
      projectId: 'project-1',
      sceneId: 'scene-1',
      candidateSnapshotId: '0123456789abcdef'
    })

    expect(restarted.openingStalled).toBe(false)
    expect(candidatePreviewPhaseOf(restarted)).toBe('opening')
  })
})

describe('isCandidateSessionRejection', () => {
  it('只把会话不存在、过期和不一致视为重开信号', () => {
    expect(isCandidateSessionRejection(4511)).toBe(true)
    expect(isCandidateSessionRejection(4512)).toBe(true)
    expect(isCandidateSessionRejection(4513)).toBe(true)
    expect(isCandidateSessionRejection(4515)).toBe(false)
    expect(isCandidateSessionRejection(5102)).toBe(false)
  })
})
