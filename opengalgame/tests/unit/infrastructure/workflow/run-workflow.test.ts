import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  Annotation,
  Command,
  END,
  GraphInterrupt,
  START,
  StateGraph,
  interrupt
} from '@langchain/langgraph'

import { ExecutionBudget } from '@infrastructure/ai/execution/ExecutionBudget'
import type { AgentStreamEvent } from '@infrastructure/ai/streaming/AgentStreamEvent'
import { FileCheckpointSaver } from '@infrastructure/workflow/checkpoints/FileCheckpointSaver'
import { runWorkflow } from '@infrastructure/workflow/execution/runWorkflow'
import { classifyWorkflowError } from '@infrastructure/workflow/execution/workflowErrors'
import { langGraphThreadKey } from '@infrastructure/workflow/WorkflowIdentity'
import { WorkflowError } from '@infrastructure/workflow/WorkflowError'

import {
  execution,
  identity,
  removeTemporaryDirectories,
  temporaryDirectory
} from './workflowFixture'

afterEach(async () => {
  vi.restoreAllMocks()
  await removeTemporaryDirectories()
})

describe('工作流执行保护', () => {
  it.each(['failed', 'cancelled', 'interrupted'] as const)(
    '观察终态正确反映 %s 并释放订阅',
    async (status) => {
      const root = await temporaryDirectory()
      const controller = new AbortController()
      const events: AgentStreamEvent[] = []
      const State = Annotation.Root({ value: Annotation<string>() })
      const graph = new StateGraph(State)
        .addNode('work', () => {
          if (status === 'failed') throw new Error('private-failure')
          if (status === 'interrupted') interrupt('need-human')
          controller.abort()
          return { value: 'done' }
        })
        .addEdge(START, 'work')
        .addEdge('work', END)
        .compile({ checkpointer: new FileCheckpointSaver(root) })
      const current = execution(root, {
        signal: controller.signal,
        observation: {
          subscriptions: [
            {
              onEvent: (event) => {
                events.push(event)
              }
            }
          ]
        }
      })
      const result = await runWorkflow(graph, {}, current).catch((error: unknown) => error)
      if (status === 'interrupted') expect(result).toMatchObject({ status: 'interrupted' })
      else
        expect(result).toMatchObject({
          category: status === 'failed' ? 'executionFailed' : 'cancelled'
        })
      expect(events.filter((event) => event.type === 'run').map((event) => event.status)).toEqual([
        'started',
        status
      ])
      expect(JSON.stringify(events)).not.toContain('private-failure')
      expect(current.budget.hasOpenRun()).toBe(false)
    }
  )

  it('真实图的观察订阅收到状态和运行终态，不暴露图状态', async () => {
    const root = await temporaryDirectory()
    const State = Annotation.Root({ value: Annotation<string>() })
    const graph = new StateGraph(State)
      .addNode('work', () => ({ value: 'private-output' }))
      .addEdge(START, 'work')
      .addEdge('work', END)
      .compile()
    const events: AgentStreamEvent[] = []
    const result = await runWorkflow(
      graph,
      { value: 'private-input' },
      execution(root, {
        observation: {
          subscriptions: [
            {
              onEvent: (event) => {
                events.push(event)
              }
            }
          ]
        }
      })
    )
    expect(result).toEqual({ status: 'completed', output: { value: 'private-output' } })
    expect(events).toContainEqual(
      expect.objectContaining({ type: 'state', node: 'work', status: 'updated' })
    )
    expect(events.filter((event) => event.type === 'run').map((event) => event.status)).toEqual([
      'started',
      'succeeded'
    ])
    expect(JSON.stringify(events)).not.toContain('private-input')
    expect(JSON.stringify(events)).not.toContain('private-output')
  })

  it('传递递归限制和取消信号，不用预算次数代替递归限制', async () => {
    const root = await temporaryDirectory()
    const seen: { recursionLimit?: number; signal?: AbortSignal; text: string } = { text: '' }
    const secret = 'sk-test-secret-value'
    const current = execution(root, {
      recursionLimit: 4,
      budget: new ExecutionBudget({ modelAttempts: 9, toolCalls: 9, activeMs: 5_000 })
    })
    ;(current as { apiKey?: string }).apiKey = secret

    await runWorkflow(
      {
        async invoke(_input, options) {
          seen.recursionLimit = options?.recursionLimit
          seen.signal = options?.signal
          seen.text = JSON.stringify(options)
          return { value: 'done' }
        }
      },
      { value: 'in' },
      current
    )

    expect(seen.recursionLimit).toBe(4)
    expect(seen.recursionLimit).not.toBe(current.budget.limits.modelAttempts)
    expect(seen.signal).toBeInstanceOf(AbortSignal)
    expect(seen.text).not.toContain(secret)
    expect(seen.text).not.toContain('ExecutionBudget')
    expect(seen.text).toContain(langGraphThreadKey(current.identity))
  })

  it('执行前拒绝取消、超时和已耗尽的预算', async () => {
    const root = await temporaryDirectory()
    const invoke = vi.fn()
    const cancelled = new AbortController()
    cancelled.abort()
    await expect(
      runWorkflow({ invoke }, {}, execution(root, { signal: cancelled.signal }))
    ).rejects.toMatchObject({ category: 'cancelled' })

    const exhausted = new ExecutionBudget(
      { modelAttempts: 1, toolCalls: 1, activeMs: 20 },
      { activeMs: 20 }
    )
    await expect(
      runWorkflow({ invoke }, {}, execution(root, { budget: exhausted }))
    ).rejects.toMatchObject({ category: 'timedOut' })
    expect(invoke).not.toHaveBeenCalled()

    const toolsExhausted = new ExecutionBudget(
      { modelAttempts: 2, toolCalls: 1, activeMs: 1_000 },
      { toolCalls: 1 }
    )
    let ran = false
    await runWorkflow(
      {
        invoke() {
          ran = true
          return { value: 'node' }
        }
      },
      {},
      execution(root, { budget: toolsExhausted })
    )
    expect(ran).toBe(true)
  })

  it('活跃时限通过信号停止执行，等待人工期间不占用也不重置预算', async () => {
    const root = await temporaryDirectory()
    const budget = new ExecutionBudget(
      { modelAttempts: 4, toolCalls: 4, activeMs: 40 },
      { modelAttempts: 2, toolCalls: 1, activeMs: 5, tokens: 3 }
    )
    await expect(
      runWorkflow(
        {
          invoke(_input, options) {
            return new Promise((_resolve, reject) => {
              options?.signal?.addEventListener('abort', () => reject(options.signal?.reason), {
                once: true
              })
            })
          }
        },
        {},
        execution(root, { budget, recursionLimit: 6 })
      )
    ).rejects.toMatchObject({ category: 'timedOut' })
    expect(budget.usage.modelAttempts).toBe(2)

    const waiting = new ExecutionBudget(
      { modelAttempts: 4, toolCalls: 4, activeMs: 5_000 },
      { modelAttempts: 2, toolCalls: 1, activeMs: 5, tokens: 3 }
    )
    const saver = new FileCheckpointSaver(root)
    const graph = compileInterrupt(saver)
    const current = execution(root, {
      budget: waiting,
      identity: identity({ operationId: 'operation-wait' })
    })
    const paused = await runWorkflow(graph, { value: 'start' }, current)
    const used = waiting.usage.activeMs
    await new Promise((resolve) => setTimeout(resolve, 40))
    expect(paused.status).toBe('interrupted')
    expect(waiting.usage.activeMs).toBe(used)
    expect(waiting.usage.modelAttempts).toBe(2)

    const resumed = await runWorkflow(graph, new Command({ resume: 'yes' }), current)
    expect(resumed.status).toBe('completed')
    expect(waiting.usage.modelAttempts).toBe(2)
    expect(waiting.usage.activeMs).toBeGreaterThanOrEqual(used)
  })

  it('人工中断不会被转换成普通失败', async () => {
    const root = await temporaryDirectory()
    const thrown = await runWorkflow(
      {
        invoke() {
          throw new GraphInterrupt([{ value: 'need-human' }])
        }
      },
      {},
      execution(root)
    )
    expect(thrown.status).toBe('interrupted')
    expect(classifyWorkflowError(new GraphInterrupt([{ value: 'need-human' }])).category).toBe(
      'interrupted'
    )
    expect(classifyWorkflowError(new GraphInterrupt([{ value: 'need-human' }])).category).not.toBe(
      'executionFailed'
    )
  })

  it('预算结算失败时保留原始执行错误和结算错误', async () => {
    const root = await temporaryDirectory()
    const runError = new Error('run-broke')
    const settleError = new Error('settle-broke')
    const budget = new ExecutionBudget({ modelAttempts: 2, toolCalls: 2, activeMs: 1_000 })
    budget.finishRun = () => {
      throw settleError
    }
    const error = await runWorkflow(
      {
        invoke() {
          throw runError
        }
      },
      {},
      execution(root, { budget })
    ).catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(WorkflowError)
    expect(error).toMatchObject({
      category: 'executionFailed',
      cause: runError,
      settlementError: settleError
    })
  })

  it('图节点看到已开始的预算，不能再次开始计量', async () => {
    const root = await temporaryDirectory()
    const budget = new ExecutionBudget({ modelAttempts: 3, toolCalls: 1, activeMs: 1_000 })
    let openDuringNode = false

    await runWorkflow(
      {
        invoke() {
          openDuringNode = budget.hasOpenRun()
          if (!budget.hasOpenRun()) budget.startRun()
          return { value: 'done' }
        }
      },
      {},
      execution(root, { budget })
    )

    expect(openDuringNode).toBe(true)
    expect(budget.hasOpenRun()).toBe(false)
    budget.startRun()
    budget.finishRun()
  })

  it('执行结束后释放取消监听、计时器和观察订阅，不创建候选工作区', async () => {
    const root = await temporaryDirectory()
    const clear = vi.spyOn(global, 'clearTimeout')
    const controller = new AbortController()
    const remove = vi.spyOn(controller.signal, 'removeEventListener')
    const subscription = new AbortController()
    const removeSubscription = vi.spyOn(subscription.signal, 'removeEventListener')
    const State = Annotation.Root({ value: Annotation<string>() })
    const graph = new StateGraph(State)
      .addNode('work', () => ({ value: 'done' }))
      .addEdge(START, 'work')
      .addEdge('work', END)
      .compile()
    const streamEvents = vi.spyOn(graph, 'streamEvents')
    const invoke = vi.spyOn(graph, 'invoke')
    const current = execution(root, {
      signal: controller.signal,
      observation: {
        subscriptions: [{ onEvent: () => undefined, signal: subscription.signal }]
      }
    })
    const workspace = join(
      root,
      'projects',
      current.identity.projectId,
      'threads',
      current.identity.threadId,
      'workspaces'
    )

    await runWorkflow(graph, {}, current)

    expect(streamEvents).toHaveBeenCalledTimes(1)
    expect(streamEvents).toHaveBeenCalledWith(
      {},
      expect.objectContaining({ version: 'v3', callbacks: expect.any(Array) })
    )
    expect(invoke).not.toHaveBeenCalled()
    expect(remove).toHaveBeenCalled()
    expect(removeSubscription).toHaveBeenCalled()
    expect(clear).toHaveBeenCalled()
    await expect(stat(workspace)).rejects.toMatchObject({ code: 'ENOENT' })
  })
})

const InterruptState = Annotation.Root({
  value: Annotation<string>({ reducer: (_left, right) => right, default: () => '' })
})
const interruptGraph = new StateGraph(InterruptState)
  .addNode('ask', (state) => {
    const answer = interrupt('need-human')
    return { value: `${state.value}:${String(answer)}` }
  })
  .addEdge(START, 'ask')
  .addEdge('ask', END)

function compileInterrupt(
  checkpointer: FileCheckpointSaver
): ReturnType<typeof interruptGraph.compile> {
  return interruptGraph.compile({ checkpointer })
}
