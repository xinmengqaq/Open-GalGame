import type { AnyAgentMiddleware } from 'langchain'
import { describe, expect, it, vi } from 'vitest'

import { ExecutionBudget } from '@infrastructure/ai/execution/ExecutionBudget'
import { executionScope, type ExecutionScope } from '@infrastructure/ai/execution/executionScope'
import {
  createBudgetGateMiddleware,
  createModelTimeoutMiddleware,
  createToolGuardMiddleware
} from '@infrastructure/ai/middleware/executionMiddleware'

describe('执行保护的运行上下文来源', () => {
  it('模型前的预算闸门只认本次运行的原生上下文，进程内作用域不能替代', async () => {
    const scope = spentScope()
    const hook = beforeModelHook(createBudgetGateMiddleware())

    await expect(
      executionScope.run(scope, async () => hook({ messages: [] }, { context: {} }))
    ).rejects.toThrow('本次执行缺少运行上下文')
  })

  it('工具执行保护只认本次运行的原生上下文，进程内作用域不能替代', async () => {
    const scope = spentScope()
    const hook = wrapToolCallHook(createToolGuardMiddleware())

    await expect(
      executionScope.run(scope, async () =>
        hook(
          { toolCall: { name: 'echo', id: 'call_1', args: {} }, runtime: { context: {} } },
          async () => 'ok'
        )
      )
    ).rejects.toThrow('本次执行缺少运行上下文')
  })

  it('缺省的模型和工具超时不安装计时器，显式短超时仍到点失败', async () => {
    vi.useFakeTimers()
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout')
    const model = wrapModelCallHook(createModelTimeoutMiddleware())
    const tool = wrapToolCallHook(createToolGuardMiddleware())
    const request = {
      runtime: {
        context: {
          budget: new ExecutionBudget({ modelAttempts: 4, toolCalls: 4, activeMs: 60000 })
        }
      },
      toolCall: { name: 'echo', id: 'call_1', args: {} }
    }

    await executionScope.run(unlimitedScope(), async () => {
      await expect(model(request, async () => 'model')).resolves.toBe('model')
      await expect(tool(request, async () => 'tool')).resolves.toBe('tool')
    })
    expect(setTimeoutSpy).not.toHaveBeenCalled()
    setTimeoutSpy.mockRestore()

    const timedOut = executionScope.run(shortTimeoutScope(), () =>
      tool(
        {
          ...request,
          tool: {
            invoke(_input: unknown, options?: { signal?: AbortSignal }) {
              const { promise, reject } = Promise.withResolvers<never>()
              const signal = options?.signal
              if (!signal) {
                reject(new Error('工具调用没有收到取消信号'))
                return promise
              }
              signal.addEventListener('abort', () => reject(signal.reason), { once: true })
              return promise
            }
          }
        },
        async (next) => {
          const callable = next as { tool?: { invoke?: (input: unknown, options?: { signal?: AbortSignal }) => Promise<unknown> } }
          if (!callable.tool?.invoke) throw new Error('工具调用没有收到可执行工具')
          return callable.tool.invoke({}, {})
        }
      )
    )
    const expectation = expect(timedOut).rejects.toThrow('单次调用超时')
    await vi.advanceTimersByTimeAsync(20)
    await expectation
    vi.useRealTimers()
  })
})

/**
 * 构造一份已经用尽次数的作用域。原生上下文缺失时不应退回到这个作用域。
 * @returns 带有已耗尽预算的执行作用域。
 */
function spentScope(): ExecutionScope {
  return {
    context: {
      budget: new ExecutionBudget(
        { modelAttempts: 1, toolCalls: 1, activeMs: 60000 },
        { modelAttempts: 1, toolCalls: 1 }
      )
    },
    requestTimeoutMs: 60000,
    toolTimeoutMs: 60000,
    toolResultCharLimit: 1000,
    summaryOutcome: 'idle'
  }
}

/** 不设单次超时的作用域。调用成功时不应安装计时器。 */
function unlimitedScope(): ExecutionScope {
  return {
    context: {
      budget: new ExecutionBudget({ modelAttempts: 4, toolCalls: 4, activeMs: 60000 })
    },
    toolResultCharLimit: 1000,
    summaryOutcome: 'idle'
  }
}

/** 只给工具一个短超时。它必须到点失败，不能被缺省路径跳过。 */
function shortTimeoutScope(): ExecutionScope {
  return {
    ...unlimitedScope(),
    toolTimeoutMs: 20
  }
}

/**
 * @returns 可直接调用的钩子。
 * @throws {Error} 中间件没有声明 beforeModel。
 */
function beforeModelHook(
  middleware: AnyAgentMiddleware
): (state: unknown, runtime: unknown) => unknown {
  const hook = middleware.beforeModel
  if (hook === undefined) throw new Error('中间件没有 beforeModel')
  return (typeof hook === 'function' ? hook : hook.hook) as (
    state: unknown,
    runtime: unknown
  ) => unknown
}

/**
 * @returns 可直接调用的钩子。
 * @throws {Error} 中间件没有声明 wrapToolCall。
 */
function wrapToolCallHook(
  middleware: AnyAgentMiddleware
): (request: unknown, handler: (request: unknown) => Promise<unknown>) => Promise<unknown> {
  const hook = middleware.wrapToolCall
  if (hook === undefined) throw new Error('中间件没有 wrapToolCall')
  return hook as (
    request: unknown,
    handler: (request: unknown) => Promise<unknown>
  ) => Promise<unknown>
}

/**
 * @returns 可直接调用的模型包装钩子。
 * @throws {Error} 中间件没有声明 wrapModelCall。
 */
function wrapModelCallHook(
  middleware: AnyAgentMiddleware
): (request: unknown, handler: (request: unknown) => Promise<unknown>) => Promise<unknown> {
  const hook = middleware.wrapModelCall
  if (hook === undefined) throw new Error('中间件没有 wrapModelCall')
  return hook as (
    request: unknown,
    handler: (request: unknown) => Promise<unknown>
  ) => Promise<unknown>
}
