import { describe, expect, it } from 'vitest'

import type {
  SceneGenerationRenderInteractionVO,
  SceneGenerationRenderStatusVO
} from '@application/scene-generation/vo/SceneGenerationRenderVO'
import { ErrorCodes } from '@common/errors/ErrorCodes'
import type { SessionCard } from '@presentation/features/workbench-session/workbenchSession.types'
import {
  acceptBlockedReasonOf,
  appendProgressStep,
  buildPrimaryReply,
  canAccept,
  canDiscard,
  canRevise,
  canSelectOption,
  countCanvasCards,
  countStatusInputs,
  effectiveDraft,
  emptyDraft,
  failureViewOf,
  generationConfirmedControls,
  generationHistoryBlockedReason,
  generationPhaseOf,
  generationPolicy,
  generationStages,
  inputSourceTextOf,
  interruptionNoteOf,
  isTerminalState,
  mergeRenderStatus,
  orderedOutcomeActions,
  outcomeActionLabel,
  outcomeNextStepOf,
  primaryReplyLabel,
  repairInstructionOf,
  repairRetryViewOf,
  replyBodyLimit,
  resumeViewOf,
  retryRepairRequestOf,
  reviewNoticeOf,
  stageRailIndex,
  startBlockedReason,
  statusPillOf,
  userMessageLabelOf,
  waitingModelNote,
  tokenViewOf,
  type GenerationOutcomeSituation,
  type GenerationStatusPill,
  trimReplyBody
} from '@presentation/pages/workbench/drawer/generation/generationPresentation'

function interaction(
  overrides: Partial<SceneGenerationRenderInteractionVO> = {}
): SceneGenerationRenderInteractionVO {
  return {
    interactionId: 'interaction-1',
    checkpointId: 'checkpoint-1',
    kind: 'decision',
    question: '旧友身份要在这里挑明吗？',
    message: '有一个创作冲突需要你决定。',
    options: [
      { id: 'reveal', label: '现在挑明', description: '让两人当场相认' },
      { id: 'hide', label: '继续隐藏', description: '把相认留到下一场' }
    ],
    allowedReplies: ['select'],
    ...overrides
  }
}

function status(
  overrides: Partial<SceneGenerationRenderStatusVO> = {}
): SceneGenerationRenderStatusVO {
  return {
    projectId: 'project-1',
    sceneId: 'scene-1',
    operationId: 'operation-1',
    threadId: 'thread-1',
    branchId: 'branch-1',
    state: 'running',
    stage: 'generating',
    stageMessage: 'AI 正在生成候选脚本',
    attempt: 0,
    sequence: 2,
    canPause: true,
    canResume: false,
    canCancel: true,
    inputSummary: {
      canvasId: 'canvas-1',
      arrangementVersion: 'v1',
      documentCount: 2,
      assetCount: 6,
      promptCount: 1,
      fieldBindingCount: 3,
      relationCount: 4,
      confirmedControlCount: 0
    },
    usage: { inputTokens: 1200, outputTokens: 3400, totalTokens: 4600, tokenLimit: null },
    previewAvailable: false,
    ...overrides
  }
}

describe('生成状态文案', () => {
  it('空状态显示准备就绪，不假装已有任务', () => {
    expect(statusPillOf(null)).toEqual({ label: '准备就绪', tone: 'ready' })
    expect(generationPhaseOf(null)).toBe('empty')
  })

  it('运行阶段按后端阶段给出中文文案', () => {
    expect(statusPillOf(status({ stage: 'readingInput' }))).toEqual({
      label: '读取输入',
      tone: 'live'
    })
    expect(statusPillOf(status({ stage: 'generating' }))).toEqual({
      label: '生成中',
      tone: 'live'
    })
    expect(statusPillOf(status({ stage: 'validating' }))).toEqual({
      label: '校验 / 修正',
      tone: 'live'
    })
    expect(statusPillOf(status({ stage: 'committing', state: 'committing' }))).toEqual({
      label: '提交中',
      tone: 'live'
    })
  })

  it('等待回复按交互种类区分决定、补充、修改和审阅', () => {
    const waiting = (kind: SceneGenerationRenderInteractionVO['kind']): GenerationStatusPill =>
      statusPillOf(
        status({ state: 'waiting', stage: 'waitingReview', interaction: interaction({ kind }) })
      )
    expect(waiting('decision')).toEqual({ label: '等待你的决定', tone: 'wait' })
    expect(waiting('clarification')).toEqual({ label: '等待补充', tone: 'wait' })
    expect(waiting('correction')).toEqual({ label: '等待修改', tone: 'wait' })
    expect(waiting('review')).toEqual({ label: '等待审阅', tone: 'wait' })
  })

  it('暂停、取消、完成和失败使用各自语义色', () => {
    expect(statusPillOf(status({ state: 'interrupted', stage: 'paused' }))).toEqual({
      label: '已暂停',
      tone: 'muted'
    })
    expect(statusPillOf(status({ state: 'cancelling' }))).toEqual({
      label: '正在取消',
      tone: 'danger'
    })
    expect(statusPillOf(status({ state: 'succeeded', stage: 'completed' }))).toEqual({
      label: '已提交',
      tone: 'done'
    })
    expect(statusPillOf(status({ state: 'failed', stage: 'failed' }))).toEqual({
      label: '生成失败',
      tone: 'danger'
    })
    expect(statusPillOf(status({ state: 'cancelled', stage: 'cancelled' }))).toEqual({
      label: '已取消',
      tone: 'muted'
    })
  })

  it('提交结果待核对时先显示待核对，不显示生成失败', () => {
    const unverified = status({
      state: 'failed',
      stage: 'failed',
      failure: { code: 5000, message: '提交结果待核对', unverified: true }
    })

    expect(statusPillOf(unverified)).toEqual({ label: '结果待核对', tone: 'wait' })
    expect(statusPillOf(unverified).label).not.toContain('生成失败')
  })
})

describe('等待模型说明', () => {
  const waiting = '等待模型响应（连接较慢时可继续等待或取消）'

  it('waitingModel 显示等待说明，旧记录和终态不显示', () => {
    expect(
      waitingModelNote(
        status({
          stage: 'generating',
          stageMessage: waiting,
          activity: { kind: 'waitingModel', lastActivityAt: '2026-10-29T00:00:00.000Z' }
        })
      )
    ).toBe(waiting)
    expect(waitingModelNote(status())).toBeNull()
    expect(
      waitingModelNote(
        status({
          state: 'failed',
          stage: 'failed',
          stageMessage: waiting,
          activity: { kind: 'waitingModel', lastActivityAt: '2026-10-29T00:00:00.000Z' }
        })
      )
    ).toBeNull()
  })
})

describe('终态与阶段判定', () => {
  it('只有成功、失败和取消是终态', () => {
    expect(isTerminalState('succeeded')).toBe(true)
    expect(isTerminalState('failed')).toBe(true)
    expect(isTerminalState('cancelled')).toBe(true)
    for (const state of [
      'pending',
      'running',
      'waiting',
      'interrupted',
      'committing',
      'cancelling'
    ] as const) {
      expect(isTerminalState(state)).toBe(false)
    }
  })

  it('旧记录的成功阶段也按统一投影显示完成，避免继续显示进度', () => {
    expect(generationPhaseOf(status({ state: 'succeeded', stage: 'completed' }))).toBe('completed')
    expect(generationPhaseOf(status({ state: 'running', stage: 'completed' }))).toBe('completed')
    expect(generationPhaseOf(status({ state: 'waiting', stage: 'waitingReview' }))).toBe('waiting')
  })

  it('暂停由 interrupted 与 paused 阶段共同表达', () => {
    expect(generationPhaseOf(status({ state: 'interrupted', stage: 'paused' }))).toBe('paused')
    expect(generationPhaseOf(status({ state: 'pending', stage: 'readingInput' }))).toBe('preparing')
    expect(generationPhaseOf(status({ state: 'waiting', stage: 'waitingReview' }))).toBe('waiting')
    expect(generationPhaseOf(status({ state: 'succeeded', stage: 'completed' }))).toBe('completed')
  })

  it('阶段轨固定六步，只按展示阶段定位，暂停和失败不猜停在第几步', () => {
    expect(generationStages.map((stage) => stage.label)).toEqual([
      '准备',
      '读取输入',
      '生成候选',
      '校验 / 修正',
      '等待审阅',
      '提交'
    ])
    expect(stageRailIndex('readingInput')).toBe(1)
    expect(stageRailIndex('generating')).toBe(2)
    expect(stageRailIndex('validating')).toBe(3)
    expect(stageRailIndex('waitingReview')).toBe(4)
    expect(stageRailIndex('committing')).toBe(5)
    expect(stageRailIndex('completed')).toBe(6)
    expect(stageRailIndex('paused')).toBeNull()
    expect(stageRailIndex('failed')).toBeNull()
    expect(stageRailIndex('cancelled')).toBeNull()
  })
})

describe('回复能力映射', () => {
  it('决定交互只允许选择选项，未选选项时不生成回复', () => {
    const decision = interaction()
    expect(canSelectOption(decision)).toBe(true)
    expect(effectiveDraft(decision, emptyDraft)).toEqual({
      interactionId: 'interaction-1',
      optionId: null,
      body: '',
      answers: {}
    })
    expect(buildPrimaryReply(decision, emptyDraft)).toBeNull()
    expect(
      buildPrimaryReply(decision, {
        interactionId: 'interaction-1',
        optionId: null,
        body: '我要加一段雨声',
        answers: {}
      })
    ).toBeNull()
    expect(
      buildPrimaryReply(decision, {
        interactionId: 'interaction-1',
        optionId: 'reveal',
        body: '',
        answers: {}
      })
    ).toEqual({ kind: 'select', optionId: 'reveal' })
    expect(
      buildPrimaryReply(decision, {
        interactionId: 'interaction-1',
        optionId: 'hide',
        body: '留到下—场',
        answers: {}
      })
    ).toEqual({ kind: 'select', optionId: 'hide', body: '留到下—场' })
  })

  it('选项数量以后端为准，不假设三个', () => {
    const options = Array.from({ length: 5 }, (_, index) => ({
      id: `option-${index}`,
      label: `选项 ${index}`,
      description: '说明'
    }))
    const five = interaction({ options })
    expect(
      buildPrimaryReply(five, {
        interactionId: 'interaction-1',
        optionId: 'option-4',
        body: '',
        answers: {}
      })
    ).toEqual({ kind: 'select', optionId: 'option-4' })
    const two = interaction({ options: options.slice(0, 2) })
    expect(
      buildPrimaryReply(two, {
        interactionId: 'interaction-1',
        optionId: 'option-3',
        body: '',
        answers: {}
      })
    ).toBeNull()
  })

  it('只允许文字补充的澄清交互发送 clarify', () => {
    const clarification = interaction({
      kind: 'clarification',
      options: [],
      allowedReplies: ['clarify']
    })
    expect(canSelectOption(clarification)).toBe(false)
    expect(
      buildPrimaryReply(clarification, {
        interactionId: 'interaction-1',
        optionId: null,
        body: '',
        answers: {}
      })
    ).toBeNull()
    expect(
      buildPrimaryReply(clarification, {
        interactionId: 'interaction-1',
        optionId: null,
        body: '让雨声先停一下',
        answers: {}
      })
    ).toEqual({ kind: 'clarify', body: '让雨声先停一下' })
  })

  it('澄清同时允许选项时优先提交选项', () => {
    const clarification = interaction({
      kind: 'clarification',
      allowedReplies: ['select', 'clarify']
    })
    expect(
      buildPrimaryReply(clarification, {
        interactionId: 'interaction-1',
        optionId: 'reveal',
        body: '',
        answers: {}
      })
    ).toEqual({ kind: 'select', optionId: 'reveal' })
    expect(
      buildPrimaryReply(clarification, {
        interactionId: 'interaction-1',
        optionId: null,
        body: '再等等',
        answers: {}
      })
    ).toEqual({ kind: 'clarify', body: '再等等' })
  })

  it('修正和审阅按能力提供修改、接受和丢弃', () => {
    const reviewing = status({ state: 'waiting', stage: 'waitingReview' })
    const correction = interaction({
      kind: 'correction',
      options: [],
      allowedReplies: ['revise', 'discard']
    })
    expect(canRevise(correction)).toBe(true)
    expect(canAccept(reviewing, correction)).toBe(false)
    expect(canDiscard(correction)).toBe(true)
    expect(primaryReplyLabel(correction)).toBe('提交修改并继续')
    expect(
      buildPrimaryReply(correction, {
        interactionId: 'interaction-1',
        optionId: null,
        body: '',
        answers: {}
      })
    ).toBeNull()
    expect(
      buildPrimaryReply(correction, {
        interactionId: 'interaction-1',
        optionId: null,
        body: '把相认放到结尾',
        answers: {}
      })
    ).toEqual({ kind: 'revise', body: '把相认放到结尾' })

    const review = interaction({
      kind: 'review',
      options: [],
      allowedReplies: ['accept', 'revise', 'discard']
    })
    expect(canAccept(reviewing, review)).toBe(true)
    expect(canRevise(review)).toBe(true)
    expect(canDiscard(review)).toBe(true)
    expect(primaryReplyLabel(review)).toBe('提交修改并继续')
  })

  it('审阅不接受修改时不显示修改能力', () => {
    const review = interaction({
      kind: 'review',
      options: [],
      allowedReplies: ['accept', 'discard']
    })
    expect(canRevise(review)).toBe(false)
    expect(
      buildPrimaryReply(review, {
        interactionId: 'interaction-1',
        optionId: null,
        body: '改一下',
        answers: {}
      })
    ).toBeNull()
  })

  it('回复正文按 2000 字上限截断，不发送 selection 摘要', () => {
    const long = '雨'.repeat(replyBodyLimit + 40)
    expect(trimReplyBody(long)).toHaveLength(replyBodyLimit)
    const reply = buildPrimaryReply(interaction(), {
      interactionId: 'interaction-1',
      optionId: 'reveal',
      body: long,
      answers: {}
    })
    expect(reply).toMatchObject({ kind: 'select', optionId: 'reveal' })
    expect(reply && 'selection' in reply).toBe(false)
  })

  it('草稿绑定交互身份，不跨问题复用', () => {
    const first = interaction()
    const draft = {
      interactionId: first.interactionId,
      optionId: 'reveal',
      body: '我的判断',
      answers: { q1: { optionId: 'q1o1', body: '保留' } }
    }
    expect(effectiveDraft(first, draft)).toBe(draft)
    const next = interaction({ interactionId: 'interaction-2' })
    expect(effectiveDraft(next, draft)).toEqual({
      interactionId: 'interaction-2',
      optionId: null,
      body: '',
      answers: {}
    })
  })

  it('问题组缺任一题时不能提交，全部选择后一次提交且不带标题', () => {
    const questions = [1, 2, 3, 4].map((index) => ({
      questionId: `q${index}`,
      prompt: `问题 ${index}`,
      options: [1, 2, 3].map((option) => ({
        id: `q${index}o${option}`,
        label: `选项 ${option}`,
        description: `说明 ${option}`
      }))
    }))
    const group = interaction({ options: [], questions, allowedReplies: ['answers', 'discard'] })
    const partial = {
      interactionId: group.interactionId,
      optionId: null,
      body: '',
      answers: {
        q1: { optionId: 'q1o1', body: ' 补充 ' },
        q2: { optionId: 'q2o2', body: '' },
        q3: { optionId: 'q3o3', body: '' }
      }
    }
    expect(buildPrimaryReply(group, partial)).toBeNull()
    expect(primaryReplyLabel(group)).toBe('提交全部回答并继续')
    expect(
      buildPrimaryReply(group, {
        ...partial,
        answers: { ...partial.answers, q4: { optionId: 'q4o1', body: '   ' } }
      })
    ).toEqual({
      kind: 'answers',
      answers: [
        { questionId: 'q1', optionId: 'q1o1', body: '补充' },
        { questionId: 'q2', optionId: 'q2o2' },
        { questionId: 'q3', optionId: 'q3o3' },
        { questionId: 'q4', optionId: 'q4o1' }
      ]
    })
  })
})
describe('Token 与输入摘要', () => {
  it('输入、输出、总量分别格式化，没有上限时不生成限额文案', () => {
    expect(
      tokenViewOf({ inputTokens: 1200, outputTokens: 3400, totalTokens: 4600, tokenLimit: null })
    ).toEqual({ input: '1,200', output: '3,400', total: '4,600', limitLabel: null })
    expect(
      tokenViewOf({ inputTokens: 10, outputTokens: 20, totalTokens: 30, tokenLimit: 100000 })
        .limitLabel
    ).toBe('上限 100,000')
  })

  it('启动前只按真实卡片种类计数', () => {
    const cards = [
      { kind: 'document' },
      { kind: 'document' },
      { kind: 'image' },
      { kind: 'audio' },
      { kind: 'video' },
      { kind: 'prompt' },
      { kind: 'animation' },
      { kind: 'effect' },
      { kind: 'effect' }
    ] as SessionCard[]
    const counts = Object.fromEntries(
      countCanvasCards(cards).map((entry) => [entry.key, entry.count])
    )
    expect(counts).toEqual({
      document: 2,
      image: 1,
      audio: 1,
      video: 1,
      prompt: 1,
      animation: 1,
      effect: 2
    })
  })

  it('启动后只读本轮快照的六个计数', () => {
    expect(countStatusInputs(status().inputSummary)).toEqual([
      { key: 'documentCount', label: '文档', count: 2 },
      { key: 'assetCount', label: '素材', count: 6 },
      { key: 'promptCount', label: '提示词', count: 1 },
      { key: 'fieldBindingCount', label: '动画 / 特效', count: 3 },
      { key: 'relationCount', label: '关联', count: 4 },
      { key: 'confirmedControlCount', label: '已确认控制', count: 0 }
    ])
  })
})

describe('开始、暂停与失败', () => {
  it('开始生成按保存、画布、环境和活动任务顺序给出唯一禁用原因', () => {
    const base = {
      saveState: 'saved' as const,
      pageBlocked: false,
      canvasReady: true,
      active: false,
      unavailableReason: null
    }
    expect(startBlockedReason(base)).toBeNull()
    expect(startBlockedReason({ ...base, pageBlocked: true })).toContain('不属于此工作台')
    expect(startBlockedReason({ ...base, canvasReady: false })).toContain('画布编排')
    expect(startBlockedReason({ ...base, unavailableReason: '当前环境不支持场景生成' })).toBe(
      '当前环境不支持场景生成'
    )
    expect(startBlockedReason({ ...base, active: true })).toContain('已有生成任务')
    expect(startBlockedReason({ ...base, saveState: 'saving' })).toContain('正在保存画布')
    expect(startBlockedReason({ ...base, saveState: 'unverified' })).toContain('保存结果待核对')
    expect(startBlockedReason({ ...base, saveState: 'failed' })).toContain('未保存')
  })

  it('只有后端允许时才显示继续，否则显示原因', () => {
    expect(
      resumeViewOf(
        status({
          state: 'interrupted',
          stage: 'paused',
          canResume: true,
          checkpointId: 'checkpoint-1'
        })
      )
    ).toEqual({
      canResume: true,
      reason: null
    })
    expect(
      resumeViewOf(
        status({
          state: 'interrupted',
          stage: 'paused',
          canResume: false,
          resumeReason: '候选已失效，只能取消'
        })
      )
    ).toEqual({ canResume: false, reason: '候选已失效，只能取消' })
    expect(resumeViewOf(status())).toEqual({ canResume: false, reason: null })
  })

  it('失败按分类显示固定标题和正文，旧 reason 只按统一桥接取标题', () => {
    const titles = [
      ['noInformationGain', '没有进展'],
      ['missingCandidateWrite', '输出不完整'],
      ['outputTruncated', '输出不完整'],
      ['missingStructuredResult', '输出不完整'],
      ['structuredOutput', '输出不完整'],
      ['modelFailure', '模型暂时不可用'],
      ['modelRejected', '要求无法继续'],
      ['modelAccess', '连接或权限需要检查'],
      ['contextOverflow', '输入过多'],
      ['correctionsExhausted', '自动修正次数已用尽']
    ] as const
    for (const [reason, title] of titles) {
      const view = failureViewOf(
        status({
          state: 'failed',
          stage: 'failed',
          failure: {
            code: ErrorCodes.operationConflict,
            message: '安全失败正文',
            reason,
            reference: 'a1b2c3d4e5f6'
          }
        })
      )
      expect(view.title).toBe(title)
      expect(view.message).toBe('安全失败正文')
      expect(view.reference).toBe('a1b2c3d4e5f6')
      expect(view.unverified).toBe(false)
      expect(view.retryHint).toBeNull()
      expect(view.message).not.toContain(String(ErrorCodes.operationConflict))
    }

    const classified = failureViewOf(
      status({
        state: 'failed',
        stage: 'failed',
        failure: {
          code: ErrorCodes.operationConflict,
          message: '安全失败正文',
          reason: 'modelFailure',
          failureClass: 'outputContract',
          reference: 'a1b2c3d4e5f6'
        }
      })
    )
    expect(classified.title).toBe('输出不完整')

    const unverified = failureViewOf(
      status({
        state: 'failed',
        stage: 'failed',
        failure: {
          code: ErrorCodes.operationConflict,
          message: '提交结果待核对',
          reference: 'c0a17b93e52d',
          unverified: true
        }
      })
    )
    expect(unverified).toEqual({
      title: '结果待核对',
      message: '提交结果待核对',
      reference: 'c0a17b93e52d',
      recordedAt: null,
      unverified: true,
      retryHint: '先重新读取任务状态，确认这次生成是否已经提交。'
    })

    const conflict = failureViewOf(
      status({
        state: 'failed',
        stage: 'failed',
        failure: {
          code: ErrorCodes.operationConflict,
          message: '候选或基线冲突，需要重新核对',
          unverified: false
        }
      })
    )
    expect(conflict.title).toBe('生成没有完成')
    expect(conflict.unverified).toBe(false)
    expect(conflict.reference).toBeNull()

    const legacy = failureViewOf(
      status({
        state: 'failed',
        stage: 'failed',
        failure: { code: ErrorCodes.operationConflict, message: '模型连接中断，本次生成未完成。' }
      })
    )
    expect(legacy.title).toBe('生成没有完成')
    expect(legacy.message).toBe('模型连接中断，本次生成未完成。')
    expect(legacy.reference).toBeNull()
    expect(legacy.recordedAt).toBeNull()

    const timed = failureViewOf(
      status({
        state: 'failed',
        stage: 'failed',
        updatedAt: '2026-10-31T12:34:56.789Z',
        failure: {
          code: ErrorCodes.operationConflict,
          message: '安全失败正文',
          reason: 'noInformationGain',
          reference: 'd4d4080fce38'
        }
      })
    )
    expect(timed.reference).toBe('d4d4080fce38')
    expect(timed.recordedAt).toBe('2026-10-31T12:34:56.789Z')

    const plain = failureViewOf(status({ state: 'failed', stage: 'failed' }))
    expect(plain).toEqual({
      title: '生成没有完成',
      message: 'AI 正在生成候选脚本',
      reference: null,
      recordedAt: null,
      unverified: false,
      retryHint: null
    })
  })

  it('生成活动期间阻止作品历史撤销', () => {
    expect(generationHistoryBlockedReason).toBe('生成进行中，暂不能撤销作品历史')
  })

  it('启动参数只提交修正次数，不提交调用、时间和 token 上限', () => {
    expect(generationConfirmedControls).toEqual([])
    expect(generationPolicy).toEqual({
      maxCorrections: 2
    })
  })
})

describe('中断、失败与只读候选', () => {
  const scope = { projectId: 'project-1', sceneId: 'scene-1' }
  const repairSource = {
    operationId: 'source-operation',
    threadId: 'source-thread',
    branchId: 'source-branch',
    checkpointId: 'source-checkpoint',
    candidateSnapshotId: 'source-candidate'
  }

  function repairFailure(
    overrides: Partial<SceneGenerationRenderStatusVO> = {}
  ): SceneGenerationRenderStatusVO {
    return status({
      state: 'failed',
      stage: 'failed',
      mode: 'repair',
      repairSource,
      candidateSnapshotId: 'failed-candidate',
      checkpointId: 'failed-checkpoint',
      userMessages: [
        { kind: 'clarify', body: '先补充一句', round: 1 },
        { kind: 'revise', body: '把相认放到结尾', round: 2 }
      ],
      failure: {
        code: ErrorCodes.operationConflict,
        message: '模型调用失败，本次生成未完成',
        reason: 'modelFailure'
      },
      ...overrides
    })
  }

  it('只有中断暂停态且检查点存在时才允许继续执行', () => {
    expect(
      resumeViewOf(
        status({
          state: 'interrupted',
          stage: 'paused',
          canResume: true,
          checkpointId: 'checkpoint-1'
        })
      )
    ).toEqual({ canResume: true, reason: null })
    expect(
      resumeViewOf(
        status({
          state: 'interrupted',
          stage: 'paused',
          canResume: true,
          checkpointId: undefined
        })
      )
    ).toEqual({
      canResume: false,
      reason: '当前任务没有可继续的检查点，本次生成不可续跑。'
    })
    expect(
      resumeViewOf(status({ state: 'interrupted', stage: 'paused', canResume: false }))
    ).toEqual({
      canResume: false,
      reason: '当前检查点不能继续，本次生成不可续跑。'
    })
    expect(resumeViewOf(status({ state: 'failed', stage: 'failed', canResume: true }))).toEqual({
      canResume: false,
      reason: null
    })
    expect(resumeViewOf(status({ state: 'running', stage: 'paused' }))).toEqual({
      canResume: false,
      reason: '这次运行不是可继续的暂停状态，本次生成不可续跑。'
    })
    expect(resumeViewOf(status())).toEqual({ canResume: false, reason: null })
  })

  it('非暂停的中断明确说明不可续跑，普通失败不冒充中断', () => {
    expect(interruptionNoteOf(status({ state: 'interrupted', stage: 'failed' }))).toContain(
      '不可续跑'
    )
    expect(
      interruptionNoteOf(
        status({
          state: 'interrupted',
          stage: 'failed',
          resumeReason: '候选已失效，只能重新生成'
        })
      )
    ).toBe('候选已失效，只能重新生成')
    expect(interruptionNoteOf(status({ state: 'failed', stage: 'failed' }))).toBeNull()
    expect(interruptionNoteOf(status({ state: 'interrupted', stage: 'paused' }))).toBeNull()
  })

  it('修复失败只携带最近一次确认的修改正文和这次失败自身的身份', () => {
    const failed = repairFailure()
    expect(repairInstructionOf(failed)).toBe('把相认放到结尾')
    expect(repairRetryViewOf(failed)).toMatchObject({
      isRepair: true,
      eligible: true,
      instruction: '把相认放到结尾',
      candidateAvailable: true,
      blocker: null
    })
    // 链式重试的来源是失败操作自身，而不是上一候选的 repairSource。
    expect(retryRepairRequestOf(failed, scope)).toEqual({
      projectId: 'project-1',
      sceneId: 'scene-1',
      canvasId: 'canvas-1',
      confirmedControls: [],
      policy: { maxCorrections: 2 },
      repair: {
        sourceOperationId: 'operation-1',
        sourceThreadId: 'thread-1',
        sourceBranchId: 'branch-1',
        sourceCheckpointId: 'failed-checkpoint',
        candidateSnapshotId: 'failed-candidate',
        instruction: '把相认放到结尾'
      }
    })
  })

  it('失败操作自身缺少检查点或候选身份时阻断重试本次修改', () => {
    for (const overrides of [{ checkpointId: undefined }, { candidateSnapshotId: undefined }]) {
      const blocked = repairFailure(overrides)
      expect(repairRetryViewOf(blocked)).toMatchObject({
        isRepair: true,
        eligible: false,
        instruction: '把相认放到结尾',
        blocker: '这次失败没有保留可重试的候选身份，不能重试本次修改。'
      })
      expect(retryRepairRequestOf(blocked, scope)).toBeNull()
    }
  })

  it('首次生成失败、中断或范围不一致时不产生重试本次修改请求', () => {
    const first = status({ state: 'failed', stage: 'failed' })
    expect(repairRetryViewOf(first)).toMatchObject({ isRepair: false, eligible: false })
    expect(retryRepairRequestOf(first, scope)).toBeNull()

    const interrupted = status({
      state: 'interrupted',
      stage: 'failed',
      checkpointId: 'checkpoint-1'
    })
    expect(repairRetryViewOf(interrupted).eligible).toBe(false)
    expect(retryRepairRequestOf(interrupted, scope)).toBeNull()

    expect(
      retryRepairRequestOf(repairFailure(), { projectId: 'project-2', sceneId: 'scene-1' })
    ).toBeNull()
  })

  it('失败待核对或缺修改正文时明确阻断，不回退成携带空正文', () => {
    const unverified = repairFailure({
      failure: {
        code: ErrorCodes.operationConflict,
        message: '提交结果待核对',
        unverified: true
      }
    })
    expect(repairRetryViewOf(unverified)).toMatchObject({
      isRepair: true,
      eligible: false,
      blocker: '先重新读取任务状态，确认这次生成是否已经提交。'
    })
    expect(retryRepairRequestOf(unverified, scope)).toBeNull()

    const noInstruction = repairFailure({
      userMessages: [{ kind: 'clarify', body: '补充一句', round: 1 }]
    })
    expect(repairRetryViewOf(noInstruction)).toMatchObject({
      isRepair: true,
      eligible: false,
      blocker: '这次失败没有可携带的修改正文，只能按画布重新生成。'
    })
    expect(retryRepairRequestOf(noInstruction, scope)).toBeNull()
  })

  it('修复重试失败只凭投影的修改指令即可再次重试', () => {
    const retried = repairFailure({
      userMessages: [{ kind: 'revise', body: '只保留站台的对白', round: 1 }],
      failure: {
        code: ErrorCodes.operationConflict,
        message: '模型调用失败，本次生成未完成',
        reason: 'modelFailure',
        unverified: false
      }
    })
    expect(repairRetryViewOf(retried)).toMatchObject({
      isRepair: true,
      eligible: true,
      instruction: '只保留站台的对白',
      blocker: null
    })
    expect(retryRepairRequestOf(retried, scope)?.repair.instruction).toBe('只保留站台的对白')
  })

  it('#19 用用户语言分别说明候选、缺失内容和下一步', () => {
    const review = interaction({
      kind: 'review',
      message: '请审阅当前候选\n完成摘要未生成，请核对创作取舍\n候选含有当前解析器不能识别的命令',
      allowedReplies: ['accept', 'revise', 'discard'],
      candidateSnapshotId: 'candidate-1'
    })
    const withCandidate = reviewNoticeOf(
      status({ state: 'waiting', stage: 'waitingReview' }),
      review
    )
    expect(withCandidate).toEqual({
      lead: '请审阅当前候选',
      notice: '已生成候选，但这次没有提供完成说明。请先核对候选内容。',
      issues: ['候选含有当前解析器不能识别的命令'],
      degraded: true
    })
    expect(JSON.stringify(withCandidate)).not.toContain('创作取舍')
    expect(canAccept(status({ state: 'waiting', stage: 'waitingReview' }), review)).toBe(false)

    const withoutCandidate = reviewNoticeOf(
      status({ state: 'waiting', stage: 'waitingReview' }),
      interaction({ kind: 'review', message: '请审阅当前候选\n完成摘要未生成，请核对创作取舍' })
    )
    expect(withoutCandidate.notice).toBe('这次没有生成新的候选。请核对失败原因和输入后重新生成。')
    expect(withoutCandidate.issues).toEqual([])
    expect(withoutCandidate.degraded).toBe(true)

    const legacyOnly = reviewNoticeOf(
      status({ state: 'waiting', stage: 'waitingReview', candidateSnapshotId: 'candidate-1' }),
      interaction({ kind: 'review', message: '完成摘要未生成，请核对创作取舍' })
    )
    expect(legacyOnly).toEqual({
      lead: '请审阅当前候选',
      notice: '已生成候选，但这次没有提供完成说明。请先核对候选内容。',
      issues: [],
      degraded: true
    })
  })

  it('降级或仍有可修正问题的审阅不提供接受，并给出修改或丢弃指引', () => {
    const reviewing = status({ state: 'waiting', stage: 'waitingReview', previewAvailable: true })
    const clean = interaction({
      kind: 'review',
      message: '请审阅当前候选',
      options: [],
      allowedReplies: ['accept', 'revise', 'discard']
    })
    expect(canAccept(reviewing, clean)).toBe(true)
    expect(acceptBlockedReasonOf(reviewing, clean)).toBeNull()

    const degraded = interaction({
      kind: 'review',
      message: '请审阅当前候选\n完成摘要未生成，请核对创作取舍',
      options: [],
      allowedReplies: ['accept', 'revise', 'discard']
    })
    expect(canAccept(reviewing, degraded)).toBe(false)
    expect(acceptBlockedReasonOf(reviewing, degraded)).toBe(
      '完成说明缺失，候选不能直接接受。请提出修改，或丢弃候选后重新生成。'
    )
    expect(canRevise(degraded)).toBe(true)
    expect(canDiscard(degraded)).toBe(true)

    const withIssues = status({
      state: 'waiting',
      stage: 'waitingReview',
      previewAvailable: false,
      knownIssues: [
        {
          code: 'unknown-command',
          message: '候选含有当前解析器不能识别的命令',
          correctable: true,
          requiresHumanDecision: false
        }
      ]
    })
    expect(canAccept(withIssues, clean)).toBe(false)
    expect(acceptBlockedReasonOf(withIssues, clean)).toBe(
      '自动修正已用尽，候选还有校验问题。请提出修改，或丢弃候选后重新生成。'
    )
  })

  it('修改和补充正文按轮次标注，不合并成同一类用户消息', () => {
    expect(userMessageLabelOf({ kind: 'revise', body: '改结尾', round: 2 })).toBe('第 2 轮修改要求')
    expect(userMessageLabelOf({ kind: 'clarify', body: '补充', round: 1 })).toBe('第 1 轮补充说明')
  })

  it('确认页输入来源只显示已保存编排的数量事实', () => {
    expect(
      inputSourceTextOf([
        { key: 'documentCount', label: '文档', count: 2 },
        { key: 'assetCount', label: '素材', count: 0 },
        { key: 'promptCount', label: '提示词', count: 1 }
      ])
    ).toBe('已保存画布编排 · 文档 2 · 提示词 1')
    expect(inputSourceTextOf([])).toBe('已保存画布编排')
  })
})

describe('终态动作主次', () => {
  const fallbackAvailable = [
    'reload',
    'regenerate',
    'view-previous-candidate',
    'open-summary',
    'cancel'
  ] as const

  function situation(
    overrides: Partial<GenerationOutcomeSituation> = {}
  ): GenerationOutcomeSituation {
    return {
      phase: 'failed',
      failureClass: null,
      unverified: false,
      ...overrides
    }
  }

  it('瞬时失败先按画布重新生成，再查看上一候选，不显示重试本次操作', () => {
    const actions = orderedOutcomeActions(situation({ failureClass: 'modelTransient' }), [
      'view-previous-candidate',
      'reload',
      'regenerate',
      'open-summary'
    ])
    expect(actions).toEqual(['regenerate', 'view-previous-candidate'])
    expect(actions).not.toContain('retry-repair')
  })

  it('鉴权失败先核对状态和输入摘要，再保留真实可用的重新生成', () => {
    expect(
      orderedOutcomeActions(situation({ failureClass: 'modelAuth' }), [
        'regenerate',
        'open-summary',
        'view-previous-candidate',
        'reload'
      ])
    ).toEqual(['reload', 'open-summary', 'regenerate'])
  })

  it('未核对结果不给重新生成，先核对任务状态', () => {
    expect(orderedOutcomeActions(situation({ unverified: true }), [...fallbackAvailable])).toEqual([
      'reload',
      'view-previous-candidate',
      'cancel'
    ])
  })

  it('修复失败把重试本次修改排在最前，没有修复身份时不伪造', () => {
    expect(
      orderedOutcomeActions(situation({ failureClass: 'noProgress' }), [
        'regenerate',
        'view-previous-candidate',
        'retry-repair'
      ])
    ).toEqual(['retry-repair', 'view-previous-candidate', 'regenerate'])
    expect(
      orderedOutcomeActions(situation({ failureClass: 'noProgress' }), [
        'regenerate',
        'view-previous-candidate'
      ])
    ).toEqual(['view-previous-candidate', 'regenerate'])
  })

  it('输出契约优先查看候选；输入无效优先返回画布，并保留重新生成', () => {
    expect(
      orderedOutcomeActions(situation({ failureClass: 'outputContract' }), [
        'reload',
        'regenerate',
        'view-previous-candidate'
      ])
    ).toEqual(['view-previous-candidate', 'regenerate'])
    expect(
      orderedOutcomeActions(situation({ failureClass: 'inputInvalid' }), [
        'open-summary',
        'return-to-canvas',
        'regenerate'
      ])
    ).toEqual(['return-to-canvas', 'open-summary', 'regenerate'])
  })

  it('被拒绝、输入过多、阻塞和修正用尽都保留真实可用的按画布重新生成', () => {
    for (const failureClass of ['modelRejected', 'contextOverflow'] as const) {
      expect(
        orderedOutcomeActions(situation({ failureClass }), ['reload', 'open-summary', 'regenerate'])
      ).toEqual(['open-summary', 'regenerate'])
    }
    expect(
      orderedOutcomeActions(situation({ failureClass: 'blocked' }), [
        'submit-revision',
        'return-to-canvas',
        'open-summary',
        'regenerate'
      ])
    ).toEqual(['return-to-canvas', 'open-summary', 'regenerate'])
    expect(
      orderedOutcomeActions(situation({ failureClass: 'correctionsExhausted' }), [
        'open-summary',
        'regenerate'
      ])
    ).toEqual(['open-summary', 'regenerate'])
    expect(
      orderedOutcomeActions(situation({ failureClass: 'internal' }), [
        'open-summary',
        'regenerate',
        'reload'
      ])
    ).toEqual(['reload', 'open-summary', 'regenerate'])
  })

  it('暂停和取消使用各自主次，不混用失败动作', () => {
    expect(
      orderedOutcomeActions(situation({ phase: 'paused' }), [...fallbackAvailable, 'resume'])
    ).toEqual(['resume', 'cancel'])
    expect(
      orderedOutcomeActions(situation({ phase: 'paused', unverified: true }), ['reload', 'cancel'])
    ).toEqual(['cancel'])
    expect(
      orderedOutcomeActions(situation({ phase: 'cancelled' }), [...fallbackAvailable])
    ).toEqual(['view-previous-candidate', 'regenerate', 'open-summary'])
  })

  it('动作标签使用用户语言并区分取消和模型鉴权', () => {
    expect(outcomeActionLabel('reload', situation({ failureClass: 'modelAuth' }))).toBe(
      '重新核对任务状态'
    )
    expect(outcomeActionLabel('reload', situation({ failureClass: 'modelTransient' }))).toBe(
      '核对任务状态'
    )
    expect(outcomeActionLabel('regenerate', situation({ phase: 'cancelled' }))).toBe('重新生成')
    expect(outcomeActionLabel('regenerate', situation())).toBe('按画布重新生成')
    expect(outcomeActionLabel('cancel', situation({ phase: 'paused' }))).toBe('结束本次生成')
    expect(outcomeActionLabel('open-summary', situation())).toBe('打开输入摘要')
  })

  it('下一步按失败分类给出方向，不展开后端错误', () => {
    expect(
      outcomeNextStepOf({
        phase: 'paused',
        failureClass: null,
        unverified: false,
        canResume: true,
        resumeReason: null,
        interruptionNote: null,
        actions: ['resume', 'cancel']
      })
    ).toContain('沿用原任务')
    expect(
      outcomeNextStepOf({
        phase: 'failed',
        failureClass: 'modelTransient',
        unverified: false,
        canResume: false,
        resumeReason: null,
        interruptionNote: null,
        actions: ['regenerate', 'view-previous-candidate']
      })
    ).toContain('不沿用上一候选')
    expect(
      outcomeNextStepOf({
        phase: 'failed',
        failureClass: null,
        unverified: true,
        canResume: false,
        resumeReason: null,
        interruptionNote: null,
        actions: ['reload']
      })
    ).toContain('核对任务状态')
    expect(
      outcomeNextStepOf({
        phase: 'failed',
        failureClass: 'inputInvalid',
        unverified: false,
        canResume: false,
        resumeReason: null,
        interruptionNote: null,
        actions: ['return-to-canvas', 'open-summary', 'regenerate']
      })
    ).toContain('返回画布')
  })

  it('下一步只提示实际存在的动作，不提示无法执行的修改要求或返回画布', () => {
    const base = {
      phase: 'failed' as const,
      unverified: false,
      canResume: false,
      resumeReason: null,
      interruptionNote: null
    }

    const blockedWithoutReturn = outcomeNextStepOf({
      ...base,
      failureClass: 'blocked',
      actions: ['open-summary', 'regenerate']
    })
    expect(blockedWithoutReturn).toContain('按画布重新生成')
    expect(blockedWithoutReturn).not.toContain('提交修改要求')
    expect(blockedWithoutReturn).not.toContain('返回画布')

    const blockedWithReturn = outcomeNextStepOf({
      ...base,
      failureClass: 'blocked',
      actions: ['submit-revision', 'return-to-canvas', 'regenerate']
    })
    expect(blockedWithReturn).toContain('返回画布')
    expect(blockedWithReturn).not.toContain('提交修改要求')

    const rejected = outcomeNextStepOf({
      ...base,
      failureClass: 'modelRejected',
      actions: ['regenerate']
    })
    expect(rejected).toContain('按画布重新生成')
    expect(rejected).not.toContain('修改要求')
    expect(rejected).not.toContain('输入摘要')

    const overflow = outcomeNextStepOf({
      ...base,
      failureClass: 'contextOverflow',
      actions: ['open-summary', 'regenerate']
    })
    expect(overflow).toContain('输入摘要')
    expect(overflow).not.toContain('修改要求')

    const inputInvalid = outcomeNextStepOf({
      ...base,
      failureClass: 'inputInvalid',
      actions: ['open-summary', 'regenerate']
    })
    expect(inputInvalid).toContain('输入摘要')
    expect(inputInvalid).not.toContain('返回画布')
  })
})

describe('进度合并', () => {
  it('同一操作只接受更大的序号，迟到响应不覆盖当前状态', () => {
    const current = status({ sequence: 5, stageMessage: 'AI 正在生成候选脚本' })
    const stale = status({ sequence: 4, stageMessage: '正在读取已保存编排与输入' })
    expect(mergeRenderStatus(current, stale)).toBe(current)
    const next = status({ sequence: 6, stageMessage: '正在校验候选脚本' })
    expect(mergeRenderStatus(current, next)).toBe(next)
    const other = status({ operationId: 'operation-2', sequence: 1 })
    expect(mergeRenderStatus(current, other)).toBe(other)
    expect(mergeRenderStatus(null, current)).toBe(current)
  })

  it('进度说明按序号累加、去重并只保留最近六条', () => {
    const first = status({ sequence: 1, stageMessage: '正在读取输入' })
    const steps = appendProgressStep([], first)
    expect(steps).toHaveLength(1)
    expect(appendProgressStep(steps, first)).toBe(steps)
    expect(appendProgressStep(steps, status({ sequence: 1, stageMessage: '正在读取输入' }))).toBe(
      steps
    )

    let current = steps
    for (let sequence = 2; sequence <= 9; sequence += 1) {
      current = appendProgressStep(current, status({ sequence, stageMessage: `阶段 ${sequence}` }))
    }
    expect(current).toHaveLength(6)
    expect(current[current.length - 1].sequence).toBe(9)
  })
})
