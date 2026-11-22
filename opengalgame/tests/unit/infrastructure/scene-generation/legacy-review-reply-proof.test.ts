import type { SceneGenerationExecution } from '@application/scene-generation/models/SceneGenerationExecution'
import type { DurableEffectRecord } from '@infrastructure/workflow/DurableEffectRecord'
import { assessLegacyReviewReply } from '@infrastructure/scene-generation/history/LegacyReviewReplyProof'
import { describe, expect, it } from 'vitest'

const candidateSnapshotId = 'a'.repeat(40)
const checkpointId = 'checkpoint-1'
const createdAt = '2026-11-21T00:00:00.000Z'
const checkpointTimestamp = '2026-11-21T00:00:05.000Z'
const updatedAt = '2026-11-21T00:00:10.000Z'

function execution(overrides: Partial<SceneGenerationExecution> = {}): SceneGenerationExecution {
  const base = {
    projectId: 'project-a',
    sceneId: 'scene-a',
    operationId: 'operation-a',
    threadId: 'thread-a',
    branchId: 'branch-a',
    fingerprint: 'fingerprint-a',
    source: {
      projectId: 'project-a',
      sceneId: 'scene-a',
      projectRoot: 'C:/project-a',
      sceneDirectory: 'game/scene',
      entryFile: 'start.txt'
    },
    inputSnapshot: {
      canvasId: 'canvas-a',
      arrangementVersion: 'arrangement-a',
      assets: [],
      documents: [],
      prompts: [],
      fieldBindings: [],
      relations: [],
      confirmedControls: []
    },
    policy: { maxCorrections: 1 },
    reviewCandidate: true,
    baseline: { commitId: 'baseline', affectedFiles: [], lockState: 'unlocked' as const },
    state: 'waiting' as const,
    attempt: 0,
    sequence: 1,
    budget: {
      correctionsUsed: 0,
      modelCallsUsed: 1,
      toolCallsUsed: 1,
      activeElapsedMs: 1
    },
    createdAt,
    updatedAt,
    replies: [],
    ...overrides
  }
  return base as SceneGenerationExecution
}

function checkpointExecution(): SceneGenerationExecution {
  return execution({
    state: 'running',
    step: undefined,
    checkpointId: undefined,
    interaction: undefined,
    pendingReply: undefined,
    candidateSnapshotId,
    updatedAt: createdAt
  })
}

function completedWrite(
  overrides: Partial<DurableEffectRecord> = {}
): DurableEffectRecord {
  return {
    operationId: 'operation-a',
    stepId: 'generate-0-initial',
    inputDigest: 'input-digest',
    status: 'completed',
    kind: 'fileWrite',
    candidateRevision: candidateSnapshotId,
    resultDigest: candidateSnapshotId,
    questions: [],
    ...overrides
  } as DurableEffectRecord
}

function reviewInteraction(
  overrides: Partial<NonNullable<SceneGenerationExecution['interaction']>> = {}
): NonNullable<SceneGenerationExecution['interaction']> {
  return {
    interactionId: 'interaction-a',
    checkpointId,
    kind: 'review',
    message: '请审阅当前候选',
    options: [],
    allowedReplies: ['accept', 'revise', 'discard'],
    candidateSnapshotId,
    ...overrides
  }
}

function waitingRecord(
  overrides: Partial<SceneGenerationExecution> = {}
): SceneGenerationExecution {
  return execution({
    candidateSnapshotId,
    checkpointId,
    interaction: reviewInteraction(),
    ...overrides
  })
}

function assess(
  overrides: Partial<Parameters<typeof assessLegacyReviewReply>[0]> = {}
): ReturnType<typeof assessLegacyReviewReply> {
  return assessLegacyReviewReply({
    checkpointId,
    checkpointExecution: checkpointExecution(),
    checkpointTimestamp,
    record: waitingRecord(),
    checkpointContinuable: true,
    inputDigestProven: true,
    candidateRevisionProven: true,
    workspaceMatchesRevision: true,
    entryPresent: true,
    effects: [completedWrite()],
    ...overrides
  })
}

describe('旧检查点审阅回复依据', () => {
  it('身份、摘要、候选、工作区、写账本、时间与审阅授权齐全时允许回复', () => {
    expect(assess()).toEqual({ replyable: true })
  })

  it('检查点可续跑不能代替回复依据', () => {
    expect(assess({ checkpointContinuable: false })).toMatchObject({ replyable: false })
    expect(assess({ record: undefined })).toMatchObject({ replyable: false })
  })

  it('执行记录与检查点身份或候选不一致时拒绝', () => {
    expect(
      assess({ record: waitingRecord({ operationId: 'operation-b' }) }).replyable
    ).toBe(false)
    expect(
      assess({ record: waitingRecord({ checkpointId: 'checkpoint-b' }) }).replyable
    ).toBe(false)
    expect(
      assess({ record: waitingRecord({ candidateSnapshotId: 'b'.repeat(40) }) }).replyable
    ).toBe(false)
  })

  it('输入摘要算不出或候选修订未能证明时拒绝', () => {
    expect(assess({ inputDigestProven: false }).replyable).toBe(false)
    expect(assess({ candidateRevisionProven: false }).replyable).toBe(false)
  })

  it('工作区与不可变修订不一致或缺少入口时拒绝', () => {
    expect(assess({ workspaceMatchesRevision: false }).replyable).toBe(false)
    expect(assess({ entryPresent: false }).replyable).toBe(false)
  })

  it('时间事实缺失、倒序或检查点时间越界时拒绝', () => {
    expect(
      assess({ record: waitingRecord({ createdAt: undefined, updatedAt: undefined }) }).replyable
    ).toBe(false)
    expect(assess({ checkpointTimestamp: '2026-11-21T00:00:20.000Z' }).replyable).toBe(false)
    expect(assess({ checkpointTimestamp: undefined }).replyable).toBe(false)
    const mismatched = checkpointExecution()
    expect(
      assess({
        checkpointExecution: { ...mismatched, createdAt: '2026-11-21T00:00:01.000Z' }
      }).replyable
    ).toBe(false)
  })

  it('写账本必须证明当前候选已完整写入且没有提交或未决记录', () => {
    expect(assess({ effects: [] }).replyable).toBe(false)
    expect(assess({ effects: [completedWrite({ status: 'started' })] }).replyable).toBe(false)
    expect(assess({ effects: [completedWrite({ status: 'unknown' })] }).replyable).toBe(false)
    expect(
      assess({ effects: [completedWrite({ candidateRevision: 'b'.repeat(40) })] }).replyable
    ).toBe(false)
    expect(assess({ effects: [completedWrite({ kind: 'commit' })] }).replyable).toBe(false)
  })

  it('审阅授权必须绑定当前检查点和候选且不扩大动作集', () => {
    expect(assess({ record: waitingRecord({ interaction: undefined }) }).replyable).toBe(false)
    expect(
      assess({
        record: waitingRecord({
          interaction: reviewInteraction({ kind: 'correction', allowedReplies: ['revise', 'discard'] })
        })
      }).replyable
    ).toBe(false)
    expect(
      assess({
        record: waitingRecord({
          interaction: reviewInteraction({ checkpointId: 'checkpoint-b' })
        })
      }).replyable
    ).toBe(false)
    expect(
      assess({
        record: waitingRecord({
          interaction: reviewInteraction({ candidateSnapshotId: 'b'.repeat(40) })
        })
      }).replyable
    ).toBe(false)
    expect(
      assess({
        record: waitingRecord({
          interaction: reviewInteraction({ allowedReplies: ['revise', 'discard'] })
        })
      }).replyable
    ).toBe(false)
    expect(
      assess({
        record: waitingRecord({
          interaction: reviewInteraction({
            allowedReplies: ['accept', 'revise', 'discard', 'answers']
          })
        })
      }).replyable
    ).toBe(false)
    expect(
      assess({
        record: waitingRecord({
          interaction: reviewInteraction({ allowedReplies: [] })
        })
      }).replyable
    ).toBe(false)
    expect(
      assess({ record: waitingRecord({ interaction: reviewInteraction({ allowedReplies: ['accept'] }) }) })
        .replyable
    ).toBe(true)
  })

  it('已持久审阅回复可在崩溃后重放；丢弃和非审阅回复不能重放', () => {
    const pending = {
      replyId: 'reply-1',
      interactionId: 'interaction-a',
      checkpointId,
      candidateSnapshotId,
      reply: { kind: 'accept' as const }
    }
    const replayable = waitingRecord({
      state: 'pending',
      interaction: undefined,
      pendingReply: pending,
      replies: [pending]
    })
    expect(assess({ record: replayable }).replyable).toBe(true)
    expect(
      assess({
        record: {
          ...replayable,
          pendingReply: { ...pending, reply: { kind: 'discard' } }
        }
      }).replyable
    ).toBe(false)
    expect(assess({ record: { ...replayable, replies: [] } }).replyable).toBe(false)
    expect(
      assess({
        record: {
          ...replayable,
          pendingReply: { ...pending, checkpointId: 'checkpoint-b' }
        }
      }).replyable
    ).toBe(false)
    expect(
      assess({
        record: {
          ...replayable,
          pendingReply: { ...pending, candidateSnapshotId: 'b'.repeat(40) }
        }
      }).replyable
    ).toBe(false)
    expect(
      assess({
        record: {
          ...replayable,
          pendingReply: { ...pending, reply: { kind: 'answers', answers: [] } }
        }
      }).replyable
    ).toBe(false)
  })

  it('终态和非等待状态不授予回复', () => {
    expect(assess({ record: waitingRecord({ state: 'failed' }) }).replyable).toBe(false)
    expect(assess({ record: waitingRecord({ state: 'interrupted' }) }).replyable).toBe(false)
  })
})
