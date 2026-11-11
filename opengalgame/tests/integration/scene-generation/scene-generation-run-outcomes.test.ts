import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { Command, isInterrupted, type LangGraphRunnableConfig } from '@langchain/langgraph'

import type {
  SceneGenerationCandidate,
  SceneGenerationExecution,
  SceneGenerationRuntime,
  SceneGenerationWorkflowProgress
} from '@application/scene-generation/models/SceneGenerationExecution'
import type { SceneGenerationArtifact } from '@domain/scene-generation/models/SceneGenerationArtifact'
import { AppException } from '@common/errors/AppException'
import { ErrorCodes } from '@common/errors/ErrorCodes'
import { ExecutionBudget } from '@infrastructure/ai/execution/ExecutionBudget'
import {
  beginWrittenFileLedger,
  recordWrittenFile
} from '@infrastructure/ai/execution/writtenFileLedger'
import {
  AttemptTimedOut,
  FinalizeRequested,
  OutputTruncated
} from '@infrastructure/ai/execution/executionErrors'
import { webGalGenerationCompatibility } from '@infrastructure/scene-generation/history/WebGalGenerationCheckpoint'
import {
  createWebGalGenerationGraph,
  generationInteraction,
  type WebGalGenerationGraph
} from '@infrastructure/scene-generation/workflow/createWebGalGenerationGraph'
import { createFinalizeNode } from '@infrastructure/scene-generation/workflow/graph/finalizeNode'
import { RunFailure } from '@infrastructure/scene-generation/workflow/runFailureRouting'
import type { WebGalGenerationStateValue } from '@infrastructure/scene-generation/workflow/WebGalGenerationState'
import { readDurableEffects } from '@infrastructure/workflow/execution/durableEffect'
import type {
  WebGalSceneAgentInput,
  WebGalSceneAgentOutput
} from '@infrastructure/scene-generation/agents/WebGalSceneAgentTypes'
import { FileCheckpointSaver } from '@infrastructure/workflow/checkpoints/FileCheckpointSaver'
import { langGraphThreadKey } from '@infrastructure/workflow/WorkflowIdentity'

const ENTRY = 'game/scene/start.txt'
const roots: string[] = []

afterEach(async () => {
  // 取消用例会让图在 invoke 拒绝后补写一次检查点；Windows 上 rmdir 需要重试到该写入完成。
  await Promise.all(
    roots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }))
  )
})

it('request_clarification 不写文件即中断，回答后按生成继续', async () => {
  const harness = await runHarness({
    reviewCandidate: true,
    agent: ({ call, budget }) => {
      if (call === 1)
        return output({
          action: 'request_clarification',
          writtenFiles: [],
          questions: [
            {
              prompt: '告别后去哪里？',
              options: [
                { label: '回家', description: '先回家。' },
                { label: '留站台', description: '留在站台。' },
                { label: '不说明', description: '留白。' }
              ]
            }
          ]
        })
      recordWrittenFile(budget, { path: ENTRY, version: `write-${call}` })
      return output()
    }
  })
  const interrupted = await harness.graph.invoke(harness.input(), harness.config)
  expect(isInterrupted(interrupted)).toBe(true)
  const waiting = await harness.graph.getState(harness.config)
  expect(waiting.values.status).toBe('waiting')
  expect(waiting.values.questions).toHaveLength(1)
  expect(waiting.values.outcome).toMatchObject({ kind: 'questions' })
  expect(waiting.values.execution.candidateSnapshotId).toBeUndefined()
  expect(generationInteraction(waiting.values, 'checkpoint-1').kind).toBe('decision')
  expect(harness.invocations[0]?.mode).toBe('generate')

  const replyId = 'reply-clarify'
  const pending = answerReply(replyId, 'answers')
  harness.live.execution = {
    ...harness.live.execution,
    pendingReply: { ...pending, selections: [{ questionId: 'q1' }] },
    replies: [{ ...pending, selections: [{ questionId: 'q1' }] }]
  }
  const resumed = await harness.graph.invoke(new Command({ resume: replyId }), harness.config)
  expect(isInterrupted(resumed)).toBe(true)
  expect(harness.calls).toBe(2)
  expect(harness.invocations.at(-1)?.mode).toBe('generate')
  const reviewed = await harness.graph.getState(harness.config)
  expect(reviewed.values.execution.candidateSnapshotId).toBeTruthy()
  expect(generationInteraction(reviewed.values, 'checkpoint-2').kind).toBe('review')
})

it('已有权威候选时请求澄清转为修正等待，不产生新题组', async () => {
  const harness = await runHarness({
    mode: 'repair',
    writtenFiles: [ENTRY],
    agent: () =>
      output({
        action: 'request_clarification',
        writtenFiles: [],
        questions: [
          {
            prompt: '保留哪一段道别？',
            options: [
              { label: '保留第一段', description: '保留第一段。' },
              { label: '保留第二段', description: '保留第二段。' },
              { label: '两段都保留', description: '都保留。' }
            ]
          }
        ]
      })
  })
  const interrupted = await harness.graph.invoke(harness.input(), harness.config)
  expect(isInterrupted(interrupted)).toBe(true)
  const waiting = await harness.graph.getState(harness.config)
  expect(waiting.values.status).toBe('waiting')
  expect(waiting.values.needsDecision).toBe(true)
  // 已有候选时题组不再进入等待事实，只把题目文案作为修正说明。
  expect(waiting.values.questions ?? []).toEqual([])
  expect(waiting.values.writtenFiles).toEqual([ENTRY])
  expect(waiting.values.execution.candidateSnapshotId).toBeUndefined()
  expect(waiting.values.outcome).toMatchObject({ kind: 'blocked', processable: true })
  const interaction = generationInteraction(waiting.values, 'checkpoint-1')
  expect(interaction.kind).toBe('correction')
  expect(interaction.message).toContain('保留哪一段道别？')
  expect(harness.calls).toBe(1)
  expect(harness.reads).toBe(0)
})

it('仅有候选修订身份时请求澄清也转为修正等待', async () => {
  const harness = await runHarness({
    candidateSnapshotId: 'a'.repeat(40),
    agent: () =>
      output({
        action: 'request_clarification',
        writtenFiles: [],
        questions: [
          {
            prompt: '候选的站台要保留吗？',
            options: [
              { label: '保留', description: '保留站台。' },
              { label: '删掉', description: '删掉站台。' },
              { label: '不说明', description: '留白。' }
            ]
          }
        ]
      })
  })
  const interrupted = await harness.graph.invoke(harness.input(), harness.config)
  expect(isInterrupted(interrupted)).toBe(true)
  const waiting = await harness.graph.getState(harness.config)
  expect(waiting.values.questions ?? []).toEqual([])
  expect(waiting.values.writtenFiles ?? []).toEqual([])
  expect(waiting.values.execution.candidateSnapshotId).toBe('a'.repeat(40))
  const interaction = generationInteraction(waiting.values, 'checkpoint-1')
  expect(interaction.kind).toBe('correction')
  expect(interaction.message).toContain('候选的站台要保留吗？')
  expect(harness.calls).toBe(1)
  expect(harness.reads).toBe(0)
})

it('仅有修复来源身份时请求澄清也转为修正等待', async () => {
  const harness = await runHarness({
    mode: 'repair',
    repairSource: {
      operationId: 'source-operation',
      threadId: 'source-thread',
      branchId: 'source-branch',
      checkpointId: 'source-checkpoint',
      candidateSnapshotId: 'source-candidate'
    },
    agent: () =>
      output({
        action: 'request_clarification',
        writtenFiles: [],
        questions: [
          {
            prompt: '修复起点保留哪一段？',
            options: [
              { label: '保留第一段', description: '保留第一段。' },
              { label: '保留第二段', description: '保留第二段。' },
              { label: '都保留', description: '都保留。' }
            ]
          }
        ]
      })
  })
  const interrupted = await harness.graph.invoke(harness.input(), harness.config)
  expect(isInterrupted(interrupted)).toBe(true)
  const waiting = await harness.graph.getState(harness.config)
  expect(waiting.values.questions ?? []).toEqual([])
  expect(waiting.values.execution.candidateSnapshotId).toBeUndefined()
  expect(waiting.values.execution.repairSource?.operationId).toBe('source-operation')
  const interaction = generationInteraction(waiting.values, 'checkpoint-1')
  expect(interaction.kind).toBe('correction')
  expect(interaction.message).toContain('修复起点保留哪一段？')
  expect(harness.calls).toBe(1)
  expect(harness.reads).toBe(0)
})

it('写前丢弃也算用掉唯一一次提问，再次请求澄清按完成契约失败', async () => {
  const harness = await runHarness({
    replies: [
      {
        projectId: 'project1',
        sceneId: 'scene1',
        operationId: 'operation1',
        threadId: 'thread1',
        branchId: 'branch1',
        interactionId: 'interaction-old',
        checkpointId: 'checkpoint-old',
        replyId: 'reply-discard',
        reply: { kind: 'discard' as const }
      }
    ],
    agent: () =>
      output({
        action: 'request_clarification',
        writtenFiles: [],
        questions: [
          {
            prompt: '还要保留站台吗？',
            options: [
              { label: '保留', description: '保留站台。' },
              { label: '删掉', description: '删掉站台。' },
              { label: '不说明', description: '留白。' }
            ]
          }
        ]
      })
  })
  const failed = await harness.graph
    .invoke(harness.input(), harness.config)
    .catch((reason) => reason)
  expect(failed).toBeInstanceOf(RunFailure)
  expect(failed).toMatchObject({ failureClass: 'outputContract', reason: 'structuredOutput' })
  expect(harness.calls).toBe(1)
})

it('修复上下文身份错配在准备节点按输入无效失败', async () => {
  const harness = await runHarness({
    mode: 'repair',
    repairSource: {
      operationId: 'operation1',
      threadId: 'thread1',
      branchId: 'branch1',
      checkpointId: 'checkpoint-source',
      candidateSnapshotId: 'candidate-source'
    },
    repairContext: {
      sourceOperationId: 'operation1',
      sourceThreadId: 'other-thread',
      sourceBranchId: 'branch1',
      sourceCheckpointId: 'checkpoint-source',
      sourceCandidateSnapshotId: 'candidate-source',
      candidatePath: ENTRY,
      instruction: '把结尾改暖',
      summary: '',
      confirmedReplies: [],
      unresolvedIssues: []
    },
    agent: () => output()
  })
  const failed = await harness.graph
    .invoke(harness.input(), harness.config)
    .catch((reason) => reason)
  expect(failed).toBeInstanceOf(RunFailure)
  expect(failed).toMatchObject({
    failureClass: 'inputInvalid',
    message: '修复来源身份与上下文不一致，不能继续本次修复'
  })
  expect(harness.calls).toBe(0)
})

it('写出后同轮请求澄清按候选继续，不产生题组', async () => {
  const harness = await runHarness({
    reviewCandidate: true,
    agent: ({ budget }) => {
      recordWrittenFile(budget, { path: ENTRY, version: 'write-clarify' })
      return output({
        action: 'request_clarification',
        writtenFiles: [ENTRY],
        unresolvedIssues: ['需要确认车站是否拆除'],
        questions: [
          {
            prompt: '还要保留站台吗？',
            options: [
              { label: '保留', description: '保留站台。' },
              { label: '删掉', description: '删掉站台。' },
              { label: '不说明', description: '留白。' }
            ]
          }
        ]
      })
    }
  })
  const interrupted = await harness.graph.invoke(harness.input(), harness.config)
  expect(isInterrupted(interrupted)).toBe(true)
  expect(harness.calls).toBe(1)
  const waiting = await harness.graph.getState(harness.config)
  expect(waiting.values.questions ?? []).toEqual([])
  expect(waiting.values.execution.candidateSnapshotId).toMatch(/^[0-9a-f]{64}$/u)
  expect(waiting.values.outcome).toMatchObject({ kind: 'candidate' })
  // 同轮写出后的创作冲突不能被丢弃，候选之后的等待应呈现澄清。
  expect(waiting.values.unresolvedIssues).toEqual(['需要确认车站是否拆除'])
  expect(waiting.values.summary).toContain('车站道别')
  // 写出候选后按候选继续，校验节点回读候选而不是沿用旧对象。
  expect(harness.reads).toBe(1)
  expect(generationInteraction(waiting.values, 'checkpoint-1').kind).toBe('clarification')
})

it('回答后再次请求澄清按完成契约失败，不产生第二组题', async () => {
  const harness = await runHarness({
    reviewCandidate: true,
    agent: ({ call }) =>
      output({
        action: 'request_clarification',
        writtenFiles: [],
        questions: [
          {
            prompt: call === 1 ? '告别后去哪里？' : '还要保留站台吗？',
            options: [
              { label: '回家', description: '先回家。' },
              { label: '留站台', description: '留在站台。' },
              { label: '不说明', description: '留白。' }
            ]
          }
        ]
      })
  })
  const interrupted = await harness.graph.invoke(harness.input(), harness.config)
  expect(isInterrupted(interrupted)).toBe(true)
  const waiting = await harness.graph.getState(harness.config)
  expect(waiting.values.questions).toHaveLength(1)
  expect(generationInteraction(waiting.values, 'checkpoint-1').kind).toBe('decision')

  const replyId = 'reply-clarify-again'
  const pending = answerReply(replyId, 'answers')
  harness.live.execution = {
    ...harness.live.execution,
    pendingReply: { ...pending, selections: [{ questionId: 'q1' }] },
    replies: [{ ...pending, selections: [{ questionId: 'q1' }] }]
  }
  const failed = await harness.graph
    .invoke(new Command({ resume: replyId }), harness.config)
    .catch((reason) => reason)
  expect(failed).toBeInstanceOf(RunFailure)
  expect(failed).toMatchObject({ failureClass: 'outputContract', reason: 'structuredOutput' })
  expect(harness.calls).toBe(2)
  // 第二次请求澄清不再形成新的决定边界，题组保持为空。
  const state = await harness.graph.getState(harness.config)
  expect(state.values.questions ?? []).toEqual([])
  expect(generationInteraction(state.values, 'checkpoint-2').kind).not.toBe('decision')
})

it('report_blocked 无写入时等待修正并展示阻塞原因', async () => {
  const harness = await runHarness({
    agent: () => output({ action: 'report_blocked', blockedReason: '缺少告别后去向的要求' })
  })
  const interrupted = await harness.graph.invoke(harness.input(), harness.config)
  expect(isInterrupted(interrupted)).toBe(true)
  const waiting = await harness.graph.getState(harness.config)
  expect(waiting.values.status).toBe('waiting')
  expect(waiting.values.needsDecision).toBe(true)
  expect(waiting.values.outcome).toMatchObject({
    kind: 'blocked',
    reason: '缺少告别后去向的要求'
  })
  expect(waiting.values.execution.candidateSnapshotId).toBeUndefined()
  const interaction = generationInteraction(waiting.values, 'checkpoint-1')
  expect(interaction.kind).toBe('correction')
  expect(interaction.message).toBe('缺少告别后去向的要求')
})

it('显式阻塞优先于旧未解决问题，不投影为澄清', async () => {
  const harness = await runHarness({
    unresolvedIssues: ['上一轮遗留的创作要求'],
    agent: () => output({ action: 'report_blocked', blockedReason: '缺少告别后去向的要求' })
  })
  const interrupted = await harness.graph.invoke(harness.input(), harness.config)
  expect(isInterrupted(interrupted)).toBe(true)
  const waiting = await harness.graph.getState(harness.config)
  expect(waiting.values.unresolvedIssues).toEqual(['上一轮遗留的创作要求'])
  const interaction = generationInteraction(waiting.values, 'checkpoint-1')
  expect(interaction.kind).toBe('correction')
  expect(interaction.message).toBe('缺少告别后去向的要求')
})

it('report_blocked 已写入时保留候选并等待修正', async () => {
  const harness = await runHarness({
    agent: ({ call, budget }) => {
      recordWrittenFile(budget, { path: ENTRY, version: `write-${call}` })
      return output({ action: 'report_blocked', blockedReason: '素材不确定是否可用' })
    }
  })
  const interrupted = await harness.graph.invoke(harness.input(), harness.config)
  expect(isInterrupted(interrupted)).toBe(true)
  const waiting = await harness.graph.getState(harness.config)
  expect(waiting.values.status).toBe('waiting')
  expect(waiting.values.execution.candidateSnapshotId).toMatch(/^[0-9a-f]{64}$/u)
  // 写节点只记录修订身份；等待节点不依赖提前读回的候选对象。
  expect(waiting.values.candidate).toBeUndefined()
  expect(waiting.values.outcome).toMatchObject({
    kind: 'blocked',
    candidateSnapshotId: waiting.values.execution.candidateSnapshotId
  })
  expect(harness.reads).toBe(0)
  expect(generationInteraction(waiting.values, 'checkpoint-1').kind).toBe('correction')
})

it('鉴权失败只调用一次并把原始错误抛出，不压成失败状态', async () => {
  const harness = await runHarness({
    agent: () => {
      throw Object.assign(new Error('unauthorized'), { status: 401 })
    }
  })
  const error = await harness.graph
    .invoke(harness.input(), harness.config)
    .catch((reason) => reason)
  expect(error).toMatchObject({ message: 'unauthorized', status: 401 })
  expect(harness.calls).toBe(1)
  const state = await harness.graph.getState(harness.config)
  expect(state.values.status).toBe('working')
  expect(state.values.failureClass).toBeUndefined()
  expect(state.values.outcome).toBeUndefined()
})

it('单次超时只重试一次，重试计数写入状态', async () => {
  const harness = await runHarness({
    agent: ({ call, budget }) => {
      if (call === 1) throw new AttemptTimedOut()
      recordWrittenFile(budget, { path: ENTRY, version: `write-${call}` })
      return output()
    }
  })
  const result = await harness.graph.invoke(harness.input(), harness.config)
  expect(isInterrupted(result)).toBe(false)
  expect(harness.calls).toBe(2)
  const state = await harness.graph.getState(harness.config)
  expect(state.values.retryCount).toBe(1)
  expect(state.values.status).toBe('ready')
  expect(harness.reads).toBe(1)
})

it('连续瞬时错误不再按重试次数失败，进度记录重试次数', async () => {
  const harness = await runHarness({
    agent: ({ call, budget }) => {
      if (call <= 3) throw new AttemptTimedOut()
      recordWrittenFile(budget, { path: ENTRY, version: `write-${call}` })
      return output()
    }
  })
  const result = await harness.graph.invoke(harness.input(), harness.config)
  expect(isInterrupted(result)).toBe(false)
  expect(harness.calls).toBe(4)
  const state = await harness.graph.getState(harness.config)
  expect(state.values.status).toBe('ready')
  expect(state.values.retryCount).toBe(3)
  expect(harness.published.flatMap((event) => event.retryCount ?? [])).toEqual([1, 2, 3])
})

it('剩余活跃时间不足一次退避时按瞬时失败收尾', async () => {
  const harness = await runHarness({
    activeMs: 100,
    agent: () => {
      throw new AttemptTimedOut()
    }
  })
  // R5 后节点不再伪造失败状态，重试节点的事实由 settle 抛给统一捕获处。
  const error = await harness.graph
    .invoke(harness.input(), harness.config)
    .catch((reason) => reason)
  expect(error).toBeInstanceOf(RunFailure)
  expect(error).toMatchObject({ failureClass: 'modelTransient' })
  expect(harness.calls).toBe(1)
  const failed = await harness.graph.getState(harness.config)
  expect(failed.values.status).toBe('failed')
  expect(failed.values.failureClass).toBe('modelTransient')
  expect(failed.values.outcome).toMatchObject({
    kind: 'modelError',
    failureClass: 'modelTransient',
    retryable: false
  })
  expect(harness.published.some((event) => event.retryCount !== undefined)).toBe(false)
})

it('用户取消中断重试等待，不继续写入候选', async () => {
  const controller = new AbortController()
  const harness = await runHarness({
    signal: controller.signal,
    onProgress: (progress) => {
      if (progress.retryCount === 1) controller.abort(new Error('用户取消'))
    },
    agent: ({ call }) => {
      if (call === 1) throw new AttemptTimedOut()
      return output()
    }
  })
  await expect(harness.graph.invoke(harness.input(), harness.config)).rejects.toThrow()
  expect(harness.calls).toBe(1)
  expect(harness.published.some((event) => event.retryCount === 1)).toBe(true)
  expect(harness.live.execution.candidateSnapshotId).toBeUndefined()
})

it('写后收尾请求按候选校验进入审阅，不再直接 finalize', async () => {
  const harness = await runHarness({
    reviewCandidate: true,
    agent: ({ call, budget }) => {
      if (call === 1) {
        recordWrittenFile(budget, { path: ENTRY, version: `write-${call}` })
        throw new FinalizeRequested('postWriteNoSubmission')
      }
      return output()
    }
  })
  const interrupted = await harness.graph.invoke(harness.input(), harness.config)
  expect(isInterrupted(interrupted)).toBe(true)
  expect(harness.calls).toBe(1)
  expect(harness.invocations[0]?.mode).toBe('generate')
  expect(harness.invocations.some((invocation) => invocation.mode === 'finalize')).toBe(false)
  const waiting = await harness.graph.getState(harness.config)
  expect(waiting.values.status).toBe('waiting')
  expect(waiting.values.execution.candidateSnapshotId).toBeTruthy()
  expect(waiting.values.outcome).toMatchObject({ kind: 'candidate' })
  expect(harness.reads).toBe(1)
  expect(generationInteraction(waiting.values, 'checkpoint-1').kind).toBe('review')
})

it('写后收尾校验通过时清空旧未解决问题，按审阅而不是澄清', async () => {
  const harness = await runHarness({
    reviewCandidate: true,
    unresolvedIssues: ['上一轮遗留的创作要求'],
    readCandidates: [candidateOf(spoken())],
    agent: ({ call, budget }) => {
      if (call === 1) {
        recordWrittenFile(budget, { path: ENTRY, version: `write-${call}` })
        throw new FinalizeRequested('postWriteNoSubmission')
      }
      return output()
    }
  })
  const interrupted = await harness.graph.invoke(harness.input(), harness.config)
  expect(isInterrupted(interrupted)).toBe(true)
  expect(harness.calls).toBe(1)
  expect(harness.invocations.some((invocation) => invocation.mode === 'finalize')).toBe(false)
  const waiting = await harness.graph.getState(harness.config)
  expect(waiting.values.unresolvedIssues ?? []).toEqual([])
  expect(generationInteraction(waiting.values, 'checkpoint-1').kind).toBe('review')
  expect(waiting.values.outcome).toMatchObject({ kind: 'candidate' })
})

it('写后收尾时非法候选交给自动修正，不再直接进入纠错', async () => {
  const harness = await runHarness({
    reviewCandidate: true,
    readCandidates: [unknownCommandCandidate(), candidateOf(spoken())],
    agent: ({ call, budget }) => {
      recordWrittenFile(budget, { path: ENTRY, version: `write-${call}` })
      if (call === 1) throw new FinalizeRequested('postWriteNoSubmission')
      return output()
    }
  })
  const interrupted = await harness.graph.invoke(harness.input(), harness.config)
  expect(isInterrupted(interrupted)).toBe(true)
  expect(harness.calls).toBe(2)
  expect(harness.invocations[1]?.mode).toBe('repair')
  const waiting = await harness.graph.getState(harness.config)
  expect(waiting.values.execution.budget.correctionsUsed).toBe(1)
  expect(waiting.values.execution.artifactValidation?.issues).toEqual([])
  expect(harness.reads).toBe(2)
  expect(generationInteraction(waiting.values, 'checkpoint-1').kind).toBe('review')
})

it('写后收尾时只有上下文问题仍交给用户补充说明，不自动改写', async () => {
  const harness = await runHarness({
    reviewCandidate: true,
    readCandidates: [contextOnlyCandidate()],
    agent: ({ call, budget }) => {
      recordWrittenFile(budget, { path: ENTRY, version: `write-${call}` })
      throw new FinalizeRequested('postWriteNoSubmission')
    }
  })
  const interrupted = await harness.graph.invoke(harness.input(), harness.config)
  expect(isInterrupted(interrupted)).toBe(true)
  expect(harness.calls).toBe(1)
  const waiting = await harness.graph.getState(harness.config)
  expect(waiting.values.status).toBe('waiting')
  expect(waiting.values.needsDecision).toBe(true)
  expect(waiting.values.execution.budget.correctionsUsed).toBe(0)
  const interaction = generationInteraction(waiting.values, 'checkpoint-1')
  expect(interaction.kind).toBe('correction')
  expect(interaction.message).toContain('连续对白缺少已建立的背景')
})

it('写后收尾时自动修正次数用尽仍进入纠错，不再自动改写', async () => {
  const harness = await runHarness({
    reviewCandidate: true,
    correctionsUsed: 2,
    readCandidates: [unknownCommandCandidate()],
    agent: ({ call, budget }) => {
      recordWrittenFile(budget, { path: ENTRY, version: `write-${call}` })
      throw new FinalizeRequested('postWriteNoSubmission')
    }
  })
  const interrupted = await harness.graph.invoke(harness.input(), harness.config)
  expect(isInterrupted(interrupted)).toBe(true)
  expect(harness.calls).toBe(1)
  const waiting = await harness.graph.getState(harness.config)
  expect(waiting.values.status).toBe('waiting')
  expect(waiting.values.needsDecision).toBe(true)
  expect(waiting.values.execution.budget.correctionsUsed).toBe(2)
  const interaction = generationInteraction(waiting.values, 'checkpoint-1')
  expect(interaction.kind).toBe('correction')
  expect(interaction.message).toContain('已自动修正 2 次')
})

it('未写候选就收尾时抛无进展失败，不压成失败状态', async () => {
  const harness = await runHarness({
    agent: ({ call }) => {
      if (call === 1) throw new FinalizeRequested('noNewInformation')
      return output({ writtenFiles: [] })
    }
  })
  const error = await harness.graph
    .invoke(harness.input(), harness.config)
    .catch((reason) => reason)
  expect(error).toBeInstanceOf(RunFailure)
  expect(error).toMatchObject({
    failureClass: 'noProgress',
    reason: 'missingStructuredResult'
  })
  expect(harness.calls).toBe(2)
  expect(harness.invocations[1]?.mode).toBe('finalize')
  const state = await harness.graph.getState(harness.config)
  expect(state.values.status).toBe('working')
  expect(state.values.failureClass).toBeUndefined()
})

it('收尾阶段结构化契约失败不重按无进展，保留候选等待审阅', async () => {
  const harness = await runHarness({
    mode: 'repair',
    candidateSnapshotId: 'a'.repeat(40),
    reviewCandidate: true,
    agent: ({ call }) => {
      if (call === 1) throw new FinalizeRequested('postWriteNoSubmission')
      throw new AppException({
        code: ErrorCodes.operationConflict,
        msg: '智能体完成结果与实际候选脚本写入不一致',
        diagnosticCategory: 'structured-output'
      })
    }
  })
  const interrupted = await harness.graph.invoke(harness.input(), harness.config)
  expect(isInterrupted(interrupted)).toBe(true)
  expect(harness.calls).toBe(2)
  expect(harness.invocations[1]?.mode).toBe('finalize')
  const waiting = await harness.graph.getState(harness.config)
  expect(waiting.values.status).toBe('waiting')
  expect(waiting.values.execution.candidateSnapshotId).toBeTruthy()
  expect(waiting.values.outcome).toMatchObject({
    kind: 'contractError',
    failureClass: 'outputContract',
    reason: 'structuredOutput',
    degraded: true
  })
  expect(harness.reads).toBe(1)
  expect(generationInteraction(waiting.values, 'checkpoint-1').kind).toBe('review')
})

it('重试成功后各步骤完成记录保持完成且不被改写', async () => {
  const harness = await runHarness({
    agent: ({ call, budget }) => {
      recordWrittenFile(budget, { path: ENTRY, version: `write-${call}` })
      if (call === 1) throw new AttemptTimedOut()
      return output()
    }
  })
  const result = await harness.graph.invoke(harness.input(), harness.config)
  expect(isInterrupted(result)).toBe(false)
  const state = await harness.graph.getState(harness.config)
  expect(state.values.status).toBe('ready')
  expect(harness.reads).toBe(1)
  expect(harness.published.some((event) => event.phase === 'failed')).toBe(false)
  const candidateEvents = harness.published.filter((event) => event.candidateSnapshotId)
  expect(candidateEvents.length).toBeGreaterThan(0)
  expect(candidateEvents[0]?.phase).not.toBe('failed')
  expect(candidateEvents[0]?.phase).not.toBe('cancelled')
  const effects = await readDurableEffects(harness.root, state.values.execution)
  expect(effects.map((effect) => effect.stepId).sort()).toEqual([
    'generate-0-initial',
    'generate-0-initial-r1'
  ])
  expect(effects.every((effect) => effect.status === 'completed')).toBe(true)
  expect(effects.every((effect) => effect.resultDigest)).toBe(true)
})

it('正常写入只写一次完成记录，题组不进入结果', async () => {
  const harness = await runHarness({
    agent: ({ call, budget }) => {
      recordWrittenFile(budget, { path: ENTRY, version: `write-${call}` })
      return output({
        questions: [
          {
            prompt: '告别后去哪里？',
            options: [
              { label: '回家', description: '先回家。' },
              { label: '留站台', description: '留在站台。' },
              { label: '不说明', description: '留白。' }
            ]
          }
        ]
      })
    }
  })
  const result = await harness.graph.invoke(harness.input(), harness.config)
  expect(isInterrupted(result)).toBe(false)
  const state = await harness.graph.getState(harness.config)
  // 候选写出后不再产生题组；模型给的 questions 不进入等待事实。
  expect(state.values.questions ?? []).toEqual([])
  expect(state.values.execution.candidateSnapshotId).toBeTruthy()
  const effects = await readDurableEffects(harness.root, state.values.execution)
  expect(effects).toHaveLength(1)
  expect(effects[0]).toMatchObject({
    stepId: 'generate-0-initial',
    status: 'completed',
    questions: []
  })
})

it('校验节点只在候选身份一致时信任已读对象，否则回读', async () => {
  const mismatched = await runHarness({
    mode: 'validate',
    lockState: 'locked',
    candidate: candidateOf(spoken(), 'b'.repeat(40)),
    agent: () => output()
  })
  await mismatched.graph.invoke(mismatched.input(), mismatched.config)
  const reread = await mismatched.graph.getState(mismatched.config)
  expect(mismatched.reads).toBe(1)
  expect(reread.values.candidate?.candidateSnapshotId).toBe('a'.repeat(40))

  const trusted = await runHarness({
    mode: 'validate',
    lockState: 'locked',
    candidate: candidateOf(spoken()),
    agent: () => output()
  })
  await trusted.graph.invoke(trusted.input(), trusted.config)
  const reused = await trusted.graph.getState(trusted.config)
  expect(trusted.reads).toBe(0)
  expect(reused.values.candidate?.candidateSnapshotId).toBe('a'.repeat(40))
})

it('收尾节点只在候选身份一致时信任已读对象，否则回读', async () => {
  const root = await mkdtemp(join(tmpdir(), 'finalize-trust-'))
  roots.push(root)
  const execution = baseExecution(root, {})
  const current = candidateOf(spoken())
  const readCandidate = vi.fn(async () => current)
  const node = createFinalizeNode({
    stateRoot: root,
    saver: new FileCheckpointSaver(root),
    artifacts: {
      readCandidate,
      saveCandidateRevision: () => Promise.resolve(current),
      writeCandidateFiles: () => Promise.resolve({ candidateSnapshotId: 'edited' })
    },
    agent: { invoke: () => Promise.resolve(output({ writtenFiles: [] })) },
    budget: new ExecutionBudget({ modelAttempts: 8, toolCalls: 8, activeMs: 900000 }),
    runtime: {
      execution,
      signal: new AbortController().signal,
      userAbortSignal: new AbortController().signal,
      activeTimeoutSignal: new AbortController().signal,
      publishProgress: () => Promise.resolve(execution),
      recordCandidateRevision: (revision) =>
        Promise.resolve({ ...execution, candidateSnapshotId: revision.candidateSnapshotId }),
      recordFailure: (failure) => Promise.resolve({ ...execution, failure })
    }
  })
  const state = {
    execution: { ...execution, candidateSnapshotId: current.candidateSnapshotId },
    mode: 'finalize',
    candidate: { ...current, candidateSnapshotId: 'b'.repeat(40) },
    summary: '',
    unresolvedIssues: [],
    memoryMessages: [],
    confirmedReplies: [],
    questions: [],
    status: 'working',
    needsDecision: false,
    writtenFiles: [],
    compatibility: webGalGenerationCompatibility()
  } as WebGalGenerationStateValue
  const mismatched = await node(state, {} as LangGraphRunnableConfig)
  expect(readCandidate).toHaveBeenCalledWith(
    expect.objectContaining({ candidateSnapshotId: current.candidateSnapshotId }),
    current.candidateSnapshotId
  )
  expect(mismatched.candidate?.candidateSnapshotId).toBe(current.candidateSnapshotId)

  readCandidate.mockClear()
  const trusted = await node({ ...state, candidate: current }, {} as LangGraphRunnableConfig)
  expect(readCandidate).not.toHaveBeenCalled()
  expect(trusted.candidate?.candidateSnapshotId).toBe(current.candidateSnapshotId)
})

it('输出截断但已写入时保留候选并进入审阅', async () => {
  const harness = await runHarness({
    reviewCandidate: true,
    agent: ({ call, budget }) => {
      recordWrittenFile(budget, { path: ENTRY, version: `write-${call}` })
      throw new OutputTruncated()
    }
  })
  const interrupted = await harness.graph.invoke(harness.input(), harness.config)
  expect(isInterrupted(interrupted)).toBe(true)
  const waiting = await harness.graph.getState(harness.config)
  expect(waiting.values.status).toBe('waiting')
  expect(waiting.values.summaryDegraded).toBe(true)
  expect(waiting.values.execution.candidateSnapshotId).toBeTruthy()
  expect(waiting.values.outcome).toMatchObject({
    kind: 'contractError',
    failureClass: 'outputContract',
    reason: 'outputTruncated',
    degraded: true
  })
  expect(harness.reads).toBe(1)
})

it('结构化非法且未写入时抛出原始错误，不压成失败状态', async () => {
  const harness = await runHarness({
    agent: () => {
      throw new AppException({
        code: ErrorCodes.invalidRequest,
        msg: '模型输出不符合约定',
        diagnosticCategory: 'structured-output'
      })
    }
  })
  const error = await harness.graph
    .invoke(harness.input(), harness.config)
    .catch((reason) => reason)
  expect(error).toBeInstanceOf(AppException)
  expect(error).toMatchObject({
    message: '模型输出不符合约定',
    diagnosticCategory: 'structured-output'
  })
  const state = await harness.graph.getState(harness.config)
  expect(state.values.status).toBe('working')
  expect(state.values.failureClass).toBeUndefined()
  expect(state.values.failureReason).toBeUndefined()
})

it('校验 rejected 时等待修正，不抛错且不再调用模型', async () => {
  const harness = await runHarness({
    mode: 'validate',
    lockState: 'locked',
    agent: () => output()
  })
  const interrupted = await harness.graph.invoke(harness.input(), harness.config)
  expect(isInterrupted(interrupted)).toBe(true)
  expect(harness.calls).toBe(0)
  const waiting = await harness.graph.getState(harness.config)
  expect(waiting.values.status).toBe('waiting')
  expect(waiting.values.needsDecision).toBe(true)
  expect(waiting.values.candidate?.candidateSnapshotId).toBe(
    harness.live.execution.candidateSnapshotId
  )
  expect(generationInteraction(waiting.values, 'checkpoint-locked').kind).toBe('correction')
})

function output(overrides: Partial<WebGalSceneAgentOutput> = {}): WebGalSceneAgentOutput {
  return {
    action: 'submit_scene_result',
    summary: '车站道别',
    writtenFiles: [ENTRY],
    usedAssetIds: [],
    unresolvedIssues: [],
    tradeoffs: [],
    questions: [],
    memoryMessages: [],
    ...overrides
  }
}

function answerReply(
  replyId: string,
  kind: 'answers'
): {
  projectId: string
  sceneId: string
  operationId: string
  threadId: string
  branchId: string
  interactionId: string
  replyId: string
  reply: { kind: 'answers'; body: string }
} {
  return {
    projectId: 'project1',
    sceneId: 'scene1',
    operationId: 'operation1',
    threadId: 'thread1',
    branchId: 'branch1',
    interactionId: concreteInteractionId(replyId),
    replyId,
    reply: { kind, body: '回家。' }
  }
}

function concreteInteractionId(replyId: string): string {
  return `interaction-${replyId}`
}

async function runHarness(options: {
  mode?: 'generate' | 'repair' | 'validate'
  lockState?: 'unlocked' | 'locked'
  reviewCandidate?: boolean
  writtenFiles?: readonly string[]
  candidate?: SceneGenerationCandidate
  readCandidates?: readonly SceneGenerationCandidate[]
  correctionsUsed?: number
  signal?: AbortSignal
  activeMs?: number
  unresolvedIssues?: readonly string[]
  candidateSnapshotId?: string
  repairSource?: NonNullable<SceneGenerationExecution['repairSource']>
  repairContext?: NonNullable<SceneGenerationExecution['repairContext']>
  replies?: SceneGenerationExecution['replies']
  onProgress?: (progress: SceneGenerationWorkflowProgress) => void
  agent: (context: {
    input: WebGalSceneAgentInput
    call: number
    budget: ExecutionBudget
  }) => WebGalSceneAgentOutput | Promise<WebGalSceneAgentOutput>
}): Promise<{
  graph: WebGalGenerationGraph
  root: string
  budget: ExecutionBudget
  config: { configurable: { thread_id: string; checkpoint_ns: string }; recursionLimit: number }
  calls: number
  reads: number
  published: SceneGenerationWorkflowProgress[]
  invocations: WebGalSceneAgentInput[]
  live: { execution: SceneGenerationExecution }
  input: () => Record<string, unknown>
}> {
  const root = await mkdtemp(join(tmpdir(), 'scene-run-outcomes-'))
  roots.push(root)
  const calls = { count: 0 }
  const reads = { count: 0 }
  const published: SceneGenerationWorkflowProgress[] = []
  const invocations: WebGalSceneAgentInput[] = []
  const execution = baseExecution(root, options)
  const live = { execution }
  const budget = new ExecutionBudget({
    modelAttempts: 32,
    toolCalls: 32,
    activeMs: options.activeMs ?? 900000
  })
  const candidate = candidateOf(spoken())
  const signal = options.signal ?? new AbortController().signal
  const graph = createWebGalGenerationGraph({
    stateRoot: root,
    saver: new FileCheckpointSaver(root),
    budget,
    runtime: {
      get execution() {
        return live.execution
      },
      signal,
      userAbortSignal: signal,
      activeTimeoutSignal: new AbortController().signal,
      publishProgress: (progress) => {
        published.push(progress)
        options.onProgress?.(progress)
        live.execution = {
          ...live.execution,
          step: progress.step,
          budget: progress.budget,
          ...(progress.candidateSnapshotId
            ? { candidateSnapshotId: progress.candidateSnapshotId }
            : {})
        }
        return Promise.resolve(live.execution)
      },
      recordCandidateRevision: (revision) => {
        live.execution = {
          ...live.execution,
          candidateSnapshotId: revision.candidateSnapshotId
        }
        return Promise.resolve(live.execution)
      },
      recordFailure: (failure) => {
        live.execution = { ...live.execution, failure }
        return Promise.resolve(live.execution)
      }
    },
    agent: {
      async invoke(input) {
        invocations.push(input)
        calls.count += 1
        beginWrittenFileLedger(budget)
        return await options.agent({ input, call: calls.count, budget })
      }
    },
    artifacts: {
      readCandidate: (_execution, candidateSnapshotId) => {
        reads.count += 1
        const served =
          options.readCandidates?.[
            Math.min(reads.count - 1, (options.readCandidates?.length ?? 1) - 1)
          ]
        return Promise.resolve(
          served ? { ...served, candidateSnapshotId } : { ...candidate, candidateSnapshotId }
        )
      },
      saveCandidateRevision: () =>
        Promise.resolve({
          candidateSnapshotId: createHash('sha256')
            .update(`saved-${calls.count}-${root}`)
            .digest('hex')
        }),
      writeCandidateFiles: () => Promise.resolve({ candidateSnapshotId: 'edited' })
    }
  })
  const config = {
    configurable: { thread_id: langGraphThreadKey(execution), checkpoint_ns: '' },
    recursionLimit: 80,
    signal
  }
  return {
    graph,
    root,
    budget,
    config,
    get calls() {
      return calls.count
    },
    get reads() {
      return reads.count
    },
    published,
    invocations,
    live,
    input: () => ({
      execution: live.execution,
      mode: options.mode ?? 'generate',
      candidate: options.candidate,
      summary: '',
      unresolvedIssues: options.unresolvedIssues ?? [],
      memoryMessages: [],
      confirmedReplies: [],
      status: 'working',
      needsDecision: false,
      correctableIssueKey: '',
      ...(options.writtenFiles ? { writtenFiles: options.writtenFiles } : {}),
      compatibility: webGalGenerationCompatibility()
    })
  }
}

function baseExecution(
  root: string,
  options: {
    lockState?: 'unlocked' | 'locked'
    reviewCandidate?: boolean
    mode?: string
    candidateSnapshotId?: string
    correctionsUsed?: number
    repairSource?: NonNullable<SceneGenerationExecution['repairSource']>
    repairContext?: NonNullable<SceneGenerationExecution['repairContext']>
    replies?: SceneGenerationExecution['replies']
  }
): SceneGenerationExecution {
  const validate = options.mode === 'validate'
  const candidateSnapshotId = validate
    ? (options.candidateSnapshotId ?? 'a'.repeat(40))
    : options.candidateSnapshotId
  return {
    projectId: 'project1',
    sceneId: 'scene1',
    operationId: 'operation1',
    threadId: 'thread1',
    branchId: 'branch1',
    fingerprint: 'fingerprint',
    source: {
      projectId: 'project1',
      sceneId: 'scene1',
      projectRoot: root,
      sceneDirectory: 'game/scene',
      entryFile: 'start.txt'
    },
    inputSnapshot: {
      canvasId: 'canvas-1',
      arrangementVersion: 'arrangement-1',
      assets: [],
      documents: [],
      prompts: [
        {
          id: 'story',
          title: '道别',
          body: '写一句道别。',
          scopes: [{ kind: 'scene' as const }],
          usage: { targetIds: [] }
        }
      ],
      fieldBindings: [],
      relations: [],
      confirmedControls: []
    },
    policy: { maxCorrections: 2 },
    reviewCandidate: options.reviewCandidate === true,
    baseline: {
      commitId: 'base',
      affectedFiles: [],
      lockState: options.lockState ?? 'unlocked'
    },
    state: 'running',
    step: 'validating',
    attempt: 0,
    sequence: 0,
    budget: {
      correctionsUsed: options.correctionsUsed ?? 0,
      modelCallsUsed: 0,
      toolCallsUsed: 0,
      activeElapsedMs: 0
    },
    replies: options.replies ?? [],
    ...(candidateSnapshotId ? { candidateSnapshotId } : {}),
    ...(options.repairSource ? { repairSource: options.repairSource } : {}),
    ...(options.repairContext ? { repairContext: options.repairContext } : {}),
    workspace: { workspaceId: 'workspace-1', rootDirectory: root, sceneDirectory: 'game/scene' }
  }
}

function candidateOf(
  artifact: SceneGenerationArtifact,
  candidateSnapshotId = 'a'.repeat(40)
): SceneGenerationCandidate {
  return {
    candidateSnapshotId,
    artifact,
    preview: {
      entryFile: ENTRY,
      files: [ENTRY],
      parserVersion: '4.6.5',
      commandLocations: [],
      assetLocations: [],
      validationReport: { issues: [] }
    },
    assetChanges: []
  }
}

function unknownCommandCandidate(): SceneGenerationCandidate {
  return candidateOf({
    scene: { projectId: 'project1', sceneId: 'scene1' },
    hasEntry: true,
    statements: [
      {
        sequence: 0,
        command: 'jumpLabel',
        commandRecognition: 'unknown',
        argumentRecognition: 'recognized',
        content: 'jumpLabel=next',
        assetUses: [],
        syntaxContract: 'generated-candidate',
        contractIssue: 'unknown-command',
        contractMessage: '当前通道不支持 jumpLabel'
      }
    ]
  })
}

function contextOnlyCandidate(): SceneGenerationCandidate {
  return candidateOf({
    scene: { projectId: 'project1', sceneId: 'scene1' },
    hasEntry: true,
    statements: [
      {
        sequence: 0,
        command: 'say',
        commandRecognition: 'recognized',
        argumentRecognition: 'recognized',
        content: '晚上好',
        assetUses: [],
        dialogueSpeaker: 'explicit',
        waitsForPlayer: true
      },
      {
        sequence: 1,
        command: 'say',
        commandRecognition: 'recognized',
        argumentRecognition: 'recognized',
        content: '明天见',
        assetUses: [],
        dialogueSpeaker: 'explicit',
        waitsForPlayer: true
      }
    ]
  })
}

function spoken(): SceneGenerationArtifact {
  return {
    scene: { projectId: 'project1', sceneId: 'scene1' },
    hasEntry: true,
    statements: [
      {
        sequence: 0,
        command: 'say',
        commandRecognition: 'recognized',
        argumentRecognition: 'recognized',
        content: '你好',
        assetUses: [],
        dialogueSpeaker: 'explicit',
        waitsForPlayer: true
      }
    ]
  }
}
