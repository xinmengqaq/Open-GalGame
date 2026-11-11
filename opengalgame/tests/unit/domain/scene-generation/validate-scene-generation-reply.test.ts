import { describe, expect, it } from 'vitest'

import { SceneGenerationDomainServiceImpl } from '@domain/scene-generation/services/impl/SceneGenerationDomainServiceImpl'
import {
  canPreviewPublishedCandidate,
  canRequestSceneGenerationPause,
  canResumeInterruptedSceneGeneration,
  canResumePausedSceneGeneration,
  canRetryFailedSceneGenerationRepair,
  type SceneGenerationReplyCheckpoint,
  type SceneGenerationReplyExecution,
  type SceneGenerationReplyInteraction,
  type SceneGenerationReplyRequest
} from '@domain/scene-generation/services/validateSceneGenerationReply'

const decisionOptions = [
  { id: 'rain', label: '雨夜离开', description: '角色在雨中离开车站' },
  { id: 'stay', label: '留在站台', description: '角色继续等待末班车' },
  { id: 'ask', label: '询问站员', description: '角色先确认末班时间' }
] as const

const decision: SceneGenerationReplyInteraction = {
  interactionId: 'interaction-1',
  checkpointId: 'checkpoint-1',
  kind: 'decision',
  options: decisionOptions,
  allowedReplies: ['select']
}

const review: SceneGenerationReplyInteraction = {
  interactionId: 'interaction-1',
  checkpointId: 'checkpoint-1',
  kind: 'review',
  options: [],
  allowedReplies: ['accept', 'revise', 'discard'],
  candidateSnapshotId: 'snapshot-1'
}

function execution(
  overrides: Partial<SceneGenerationReplyExecution> = {}
): SceneGenerationReplyExecution {
  return {
    projectId: 'project-1',
    sceneId: 'scene-1',
    operationId: 'operation-1',
    threadId: 'thread-1',
    branchId: 'branch-1',
    state: 'waiting',
    checkpointId: 'checkpoint-1',
    interaction: decision,
    replies: [],
    ...overrides
  }
}

function request(
  overrides: Partial<SceneGenerationReplyRequest> = {}
): SceneGenerationReplyRequest {
  return {
    projectId: 'project-1',
    sceneId: 'scene-1',
    operationId: 'operation-1',
    threadId: 'thread-1',
    branchId: 'branch-1',
    interactionId: 'interaction-1',
    checkpointId: 'checkpoint-1',
    replyId: 'reply-1',
    reply: { kind: 'select', optionId: 'stay', body: ' 再等一班 ' },
    ...overrides
  }
}

function checkpoint(
  overrides: Partial<SceneGenerationReplyCheckpoint> = {}
): SceneGenerationReplyCheckpoint {
  return {
    checkpointId: 'checkpoint-1',
    operationId: 'operation-1',
    threadId: 'thread-1',
    branchId: 'branch-1',
    canContinue: true,
    ...overrides
  }
}

function questionGroup(count: number): SceneGenerationReplyInteraction {
  return {
    ...decision,
    options: [],
    allowedReplies: ['answers'],
    questions: Array.from({ length: count }, (_, questionIndex) => ({
      questionId: `q${questionIndex + 1}`,
      prompt: `问题 ${questionIndex + 1}`,
      options: [1, 2, 3].map((optionIndex) => ({
        id: `q${questionIndex + 1}o${optionIndex}`,
        label: `选项 ${optionIndex}`,
        description: `说明 ${optionIndex}`
      }))
    }))
  }
}

function groupReply(interaction: SceneGenerationReplyInteraction, bodies: readonly string[] = []) {
  return {
    ...request(),
    reply: {
      kind: 'answers' as const,
      answers: (interaction.questions ?? []).map((question, index) => ({
        questionId: question.questionId,
        optionId: question.options[1]?.id ?? question.options[0].id,
        ...(bodies[index] === undefined ? {} : { body: bodies[index] })
      }))
    }
  }
}
const domain = new SceneGenerationDomainServiceImpl()

describe('validateSceneGenerationReply', () => {
  it('选择回复带回选项标题、说明和去除空白的自由文本', () => {
    expect(domain.validateReply(execution(), request(), checkpoint())).toEqual({
      optionId: 'stay',
      label: '留在站台',
      description: '角色继续等待末班车',
      body: '再等一班'
    })
  })

  it('空白自由文本只保留选项事实', () => {
    expect(
      domain.validateReply(
        execution(),
        request({ reply: { kind: 'select', optionId: 'stay', body: '  ' } }),
        checkpoint()
      )
    ).toEqual({
      optionId: 'stay',
      label: '留在站台',
      description: '角色继续等待末班车'
    })
  })

  it('创作决策不是恰好三项、身份重复或说明空白时拒绝', () => {
    const cases: SceneGenerationReplyInteraction[] = [
      { ...decision, options: decisionOptions.slice(0, 2) },
      {
        ...decision,
        options: [decisionOptions[0], decisionOptions[0], decisionOptions[1]]
      },
      {
        ...decision,
        options: [
          { ...decisionOptions[0], description: ' ' },
          decisionOptions[1],
          decisionOptions[2]
        ]
      }
    ]
    for (const interaction of cases) {
      expect(() =>
        domain.validateReply(execution({ interaction }), request(), checkpoint())
      ).toThrowError(expect.objectContaining({ code: 4101 }))
    }
  })

  it('1 题和 4 题整组回答按问题顺序返回服务端事实', () => {
    const one = questionGroup(1)
    expect(
      domain.validateReply(
        execution({ interaction: one }),
        groupReply(one, [' 补充 ']),
        checkpoint()
      )
    ).toEqual([
      {
        questionId: 'q1',
        prompt: '问题 1',
        optionId: 'q1o2',
        label: '选项 2',
        description: '说明 2',
        body: '补充'
      }
    ])
    const four = questionGroup(4)
    const facts = domain.validateReply(
      execution({ interaction: four }),
      groupReply(four, ['', '  ', '保留', '']),
      checkpoint()
    )
    expect(Array.isArray(facts) ? facts.map((fact) => fact.questionId) : []).toEqual([
      'q1',
      'q2',
      'q3',
      'q4'
    ])
    expect(Array.isArray(facts) ? facts[2] : undefined).toMatchObject({ body: '保留' })
    expect(Array.isArray(facts) ? facts[0] : undefined).not.toHaveProperty('body')
  })

  it('0 题、5 题、缺题、重复题、跨题选项和旧问题都拒绝', () => {
    const current = questionGroup(2)
    const repeated = groupReply(current).reply.answers[0]
    const cases = [
      { ...request(), reply: { kind: 'answers' as const, answers: [] } },
      { ...request(), reply: { kind: 'answers' as const, answers: [repeated, repeated] } },
      {
        ...request(),
        reply: {
          kind: 'answers' as const,
          answers: [
            { questionId: 'q1', optionId: 'q2o1' },
            { questionId: 'q2', optionId: 'q1o1' }
          ]
        }
      },
      {
        ...request(),
        reply: {
          kind: 'answers' as const,
          answers: [
            { questionId: 'old-question', optionId: 'q1o1' },
            { questionId: 'q2', optionId: 'q2o1' }
          ]
        }
      }
    ]
    for (const interaction of [{ ...questionGroup(1), questions: [] }, questionGroup(5)]) {
      expect(() =>
        domain.validateReply(execution({ interaction }), groupReply(questionGroup(1)), checkpoint())
      ).toThrowError(expect.objectContaining({ code: 4101 }))
    }
    for (const invalid of cases) {
      expect(() =>
        domain.validateReply(execution({ interaction: current }), invalid, checkpoint())
      ).toThrowError(expect.objectContaining({ code: expect.any(Number) }))
    }
  })
  it('旧线程、旧交互、旧检查点、旧候选和重复回复都拒绝', () => {
    const cases: Array<Partial<SceneGenerationReplyRequest>> = [
      { threadId: 'old-thread' },
      { branchId: 'old-branch' },
      { interactionId: 'old-interaction' },
      { checkpointId: 'old-checkpoint' },
      { candidateSnapshotId: 'old-snapshot' },
      { replyId: 'reply-1' }
    ]
    const current = execution({ replies: [{ replyId: 'reply-1' }] })
    for (const override of cases) {
      expect(() => domain.validateReply(current, request(override), checkpoint())).toThrowError(
        expect.objectContaining({ code: 4103 })
      )
    }
  })

  it('不存在的选项、超长正文和空白修改说明拒绝', () => {
    expect(() =>
      domain.validateReply(
        execution(),
        request({ reply: { kind: 'select', optionId: 'missing' } }),
        checkpoint()
      )
    ).toThrowError(expect.objectContaining({ code: 4101 }))
    expect(() =>
      domain.validateReply(
        execution(),
        request({ reply: { kind: 'select', optionId: 'stay', body: '雨'.repeat(2001) } }),
        checkpoint()
      )
    ).toThrowError(expect.objectContaining({ code: 4101 }))
    expect(() =>
      domain.validateReply(
        execution({
          interaction: { ...review, allowedReplies: ['revise'] },
          candidateSnapshotId: 'snapshot-1'
        }),
        request({ reply: { kind: 'revise', body: '  ' }, candidateSnapshotId: 'snapshot-1' }),
        checkpoint()
      )
    ).toThrowError(expect.objectContaining({ code: 4101 }))
  })

  it('审阅只允许接受、修改或丢弃，旧回复不能批准新候选', () => {
    expect(() =>
      domain.validateReply(
        execution({ interaction: review, candidateSnapshotId: 'snapshot-1' }),
        request({
          reply: { kind: 'select', optionId: 'stay' },
          candidateSnapshotId: 'snapshot-1'
        }),
        checkpoint()
      )
    ).toThrowError(expect.objectContaining({ code: 4101 }))
    expect(() =>
      domain.validateReply(
        execution({
          interaction: { ...review, candidateSnapshotId: 'snapshot-old' },
          candidateSnapshotId: 'snapshot-1'
        }),
        request({ reply: { kind: 'accept' }, candidateSnapshotId: 'snapshot-old' }),
        checkpoint()
      )
    ).toThrowError(expect.objectContaining({ code: 4103 }))
    expect(
      domain.validateReply(
        execution({ interaction: review, candidateSnapshotId: 'snapshot-1' }),
        request({ reply: { kind: 'revise', body: ' 改结尾 ' }, candidateSnapshotId: 'snapshot-1' }),
        checkpoint()
      )
    ).toBeUndefined()
  })

  it('候选存在后旧题组回复一律失效', () => {
    const stale = execution({ candidateSnapshotId: 'snapshot-2' })
    expect(() =>
      domain.validateReply(stale, request(), checkpoint({ candidateSnapshotId: 'snapshot-2' }))
    ).toThrowError(
      expect.objectContaining({
        code: 4103,
        message: '候选已存在，旧题组已失效，请按候选继续修改或重新生成'
      })
    )
    expect(() =>
      domain.validateReply(
        execution({ candidateSnapshotId: 'snapshot-2' }),
        groupReply(questionGroup(1)),
        checkpoint({ candidateSnapshotId: 'snapshot-2' })
      )
    ).toThrowError(expect.objectContaining({ code: 4103 }))
  })

  it('不能继续的检查点拒绝回复', () => {
    expect(() =>
      domain.validateReply(execution(), request(), checkpoint({ canContinue: false }))
    ).toThrowError(expect.objectContaining({ code: 4103 }))
  })

  it('提交中、提交不明和候选冲突不能请求或恢复为暂停', () => {
    expect(canRequestSceneGenerationPause(execution({ state: 'running' }))).toBe(true)
    expect(canRequestSceneGenerationPause(execution({ state: 'committing' }))).toBe(false)
    expect(
      canRequestSceneGenerationPause(
        execution({ state: 'running', interruptReason: 'commitUnknown' })
      )
    ).toBe(false)
    expect(
      canRequestSceneGenerationPause(
        execution({ state: 'running', interruptReason: 'candidateConflict' })
      )
    ).toBe(false)
    const paused = execution({
      state: 'interrupted',
      interruptReason: 'paused',
      interaction: undefined
    })
    expect(canResumePausedSceneGeneration(paused, checkpoint())).toBe(true)
    expect(
      canResumePausedSceneGeneration({ ...paused, interruptReason: 'commitUnknown' }, checkpoint())
    ).toBe(false)
    expect(canResumePausedSceneGeneration(paused, checkpoint({ canContinue: false }))).toBe(false)
    expect(
      canResumePausedSceneGeneration({ ...paused, checkpointId: undefined }, checkpoint())
    ).toBe(false)
  })

  it('未终态中断可沿原检查点恢复，取消和失败不能续跑', () => {
    const interrupted = execution({
      state: 'running',
      interruptReason: undefined,
      interaction: undefined
    })
    expect(canResumeInterruptedSceneGeneration(interrupted, checkpoint())).toBe(true)
    expect(
      canResumeInterruptedSceneGeneration({ ...interrupted, state: 'cancelled' }, checkpoint())
    ).toBe(false)
    expect(
      canResumeInterruptedSceneGeneration({ ...interrupted, state: 'failed' }, checkpoint())
    ).toBe(false)
    expect(
      canResumeInterruptedSceneGeneration(
        { ...interrupted, interruptReason: 'commitUnknown' },
        checkpoint()
      )
    ).toBe(false)
    expect(
      canResumeInterruptedSceneGeneration(interrupted, checkpoint({ canContinue: false }))
    ).toBe(false)
  })

  it('修复重跑只接受已失败来源上确认过的同一修改正文', () => {
    const failed = execution({
      state: 'failed',
      interaction: undefined,
      candidateSnapshotId: 'snapshot-1',
      replies: [{ replyId: 'reply-1', reply: { kind: 'revise', body: '改结尾' } }]
    })
    const request = {
      projectId: 'project-1',
      sceneId: 'scene-1',
      sourceOperationId: 'operation-1',
      sourceThreadId: 'thread-1',
      sourceBranchId: 'branch-1',
      sourceCheckpointId: 'checkpoint-1',
      candidateSnapshotId: 'snapshot-1',
      instruction: '改结尾'
    }
    expect(canRetryFailedSceneGenerationRepair(failed, request)).toBe(true)
    expect(canRetryFailedSceneGenerationRepair({ ...failed, state: 'cancelled' }, request)).toBe(
      false
    )
    expect(canRetryFailedSceneGenerationRepair(failed, { ...request, instruction: '另一句' })).toBe(
      false
    )
    expect(
      canRetryFailedSceneGenerationRepair(failed, {
        ...request,
        candidateSnapshotId: 'other-snapshot'
      })
    ).toBe(false)
  })

  it('候选预览只接受已发布且归属匹配的修订身份', () => {
    const published = [checkpoint()]
    expect(canPreviewPublishedCandidate(checkpoint(), published)).toBe(true)
    expect(
      canPreviewPublishedCandidate(
        { ...checkpoint(), candidateSnapshotId: 'workspace-copy' },
        published
      )
    ).toBe(false)
    expect(canPreviewPublishedCandidate(checkpoint(), [])).toBe(false)
  })
})
