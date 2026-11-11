import { afterEach, expect, it, vi } from 'vitest'

import { ExecutionBudget } from '@infrastructure/ai/execution/ExecutionBudget'
import { SceneGenerationProgressPublisher } from '@infrastructure/scene-generation/workflow/SceneGenerationProgressPublisher'
import type { SceneGenerationWorkflowProgress } from '@application/scene-generation/models/SceneGenerationExecution'

afterEach(() => {
  vi.useRealTimers()
})

it('开始后先发布等待，模型计数变化后合并发布，结束后不再发布', async () => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-10-29T00:00:00.000Z'))
  const published: SceneGenerationWorkflowProgress[] = []
  const budget = new ExecutionBudget({
    modelAttempts: Number.MAX_SAFE_INTEGER,
    toolCalls: Number.MAX_SAFE_INTEGER,
    activeMs: Number.MAX_SAFE_INTEGER
  })
  const publisher = new SceneGenerationProgressPublisher({
    publish: async (progress) => {
      published.push(progress)
      return {} as never
    },
    budget,
    previousBudget: () => ({
      correctionsUsed: 2,
      modelCallsUsed: 0,
      toolCallsUsed: 0,
      activeElapsedMs: 0
    }),
    attempt: () => 1,
    now: Date.now,
    publishIntervalMs: 1500,
    idleNoticeMs: 30000
  })
  publisher.start()
  await vi.advanceTimersByTimeAsync(0)
  expect(published[0]?.step).toBe('generating')
  expect(published[0]?.live?.activity).toBe('waitingModel')
  budget.consumeModelAttempt()
  publisher.observe({ kind: 'model-end', at: Date.now(), usage: budget.usage })
  budget.consumeToolCall()
  publisher.observe({
    kind: 'tool-end',
    at: Date.now(),
    usage: budget.usage,
    lastToolName: 'readTextRange'
  })
  await vi.advanceTimersByTimeAsync(1500)
  expect(published.at(-1)?.budget.correctionsUsed).toBe(2)
  await vi.advanceTimersByTimeAsync(1500)
  expect(published.at(-1)?.budget.modelCallsUsed).toBe(1)
  expect(published.at(-1)?.budget.toolCallsUsed).toBe(1)
  expect(published.at(-1)?.live?.lastToolName).toBe('readTextRange')
  publisher.observe({
    kind: 'tool-end',
    at: Date.now(),
    usage: budget.usage,
    lastToolName: 'read_file'
  })
  await vi.advanceTimersByTimeAsync(1500)
  expect(published.at(-1)?.live?.lastToolName).toBeUndefined()
  const finished = published.length
  publisher.dispose()
  await vi.advanceTimersByTimeAsync(60000)
  expect(published.length).toBe(finished)
})

it('取消信号到达后不再发布', async () => {
  vi.useFakeTimers()
  const controller = new AbortController()
  const published: SceneGenerationWorkflowProgress[] = []
  const publisher = new SceneGenerationProgressPublisher({
    publish: async (progress) => {
      published.push(progress)
      return {} as never
    },
    budget: new ExecutionBudget({ modelAttempts: 4, toolCalls: 4, activeMs: 900000 }),
    previousBudget: () => ({
      correctionsUsed: 0,
      modelCallsUsed: 0,
      toolCallsUsed: 0,
      activeElapsedMs: 0
    }),
    attempt: () => 1,
    signal: controller.signal,
    publishIntervalMs: 10,
    idleNoticeMs: 50
  })
  publisher.start()
  controller.abort()
  await vi.advanceTimersByTimeAsync(1000)
  expect(published).toEqual([])
})

it('发布返回后若已停止，不再排队覆盖终态', async () => {
  vi.useFakeTimers()
  const published: SceneGenerationWorkflowProgress[] = []
  let releasePublish: () => void = () => undefined
  const publisher = new SceneGenerationProgressPublisher({
    publish: () =>
      new Promise((resolve) => {
        releasePublish = () => {
          published.push({
            step: 'generating',
            attempt: 1,
            budget: {
              correctionsUsed: 0,
              modelCallsUsed: 0,
              toolCallsUsed: 0,
              activeElapsedMs: 0
            },
            live: { activity: 'waitingModel', lastActivityAt: '2026-10-29T00:00:00.000Z' }
          })
          resolve({} as never)
        }
      }),
    budget: new ExecutionBudget({ modelAttempts: 4, toolCalls: 4, activeMs: 900000 }),
    previousBudget: () => ({
      correctionsUsed: 0,
      modelCallsUsed: 0,
      toolCallsUsed: 0,
      activeElapsedMs: 0
    }),
    attempt: () => 1,
    publishIntervalMs: 10,
    idleNoticeMs: 50
  })
  publisher.start()
  await vi.advanceTimersByTimeAsync(0)
  publisher.dispose()
  releasePublish()
  await vi.advanceTimersByTimeAsync(1000)
  expect(published).toHaveLength(1)
})
