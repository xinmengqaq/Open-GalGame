import type { RunnableConfig } from '@langchain/core/runnables'
import { isInterrupted, type GraphRunStream } from '@langchain/langgraph'

import { AppException } from '@common/errors/AppException'
import { ErrorCodes } from '@common/errors/ErrorCodes'

import { ActiveLimitExceeded } from '@infrastructure/ai/execution/executionErrors'
import { createAgentStreamConsumer } from '@infrastructure/ai/streaming/AgentStreamConsumer'
import { LangChainEventStreamAdapter } from '@infrastructure/ai/streaming/LangChainEventStreamAdapter'

import { WorkflowError } from '../WorkflowError'
import {
  createWorkflowExecution,
  type WorkflowExecution,
  type WorkflowOperationPhase
} from '../WorkflowExecution'
import { langGraphThreadKey } from '../WorkflowIdentity'
import { recordOperationPhase } from '../checkpoints/checkpointPath'
import { classifyWorkflowError } from './workflowErrors'

const TIMER_LIMIT = 2_147_483_647

export type WorkflowRunResult<Output> =
  { status: 'completed'; output: Output } | { status: 'interrupted'; output: Output }

/**
 * 在调用方已经编译的 LangGraph 外加上预算、取消、递归限制和资源释放。
 * @param graph - 调用方编译好的图。本函数不创建节点或编译图。
 * @returns 完成或人工中断。中断不会被转换成普通失败。
 * @throws {WorkflowError | AppException} 取消、超时、预算或技术执行失败。结算失败会保留原始错误。
 */
export async function runWorkflow<Input, Output>(
  graph: {
    invoke(input: Input, options?: RunnableConfig): Promise<Output>
    streamEvents?(
      input: Input,
      options: RunnableConfig & { version: 'v3' }
    ): Promise<GraphRunStream<unknown>>
  },
  input: Input,
  execution: WorkflowExecution
): Promise<WorkflowRunResult<Output>> {
  const checked = createWorkflowExecution(execution)
  const budget = checked.budget
  const controller = new AbortController()
  const onAbort = (): void => controller.abort(checked.signal?.reason)
  let listening = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let budgetStarted = false
  let failed: unknown
  let output: Output | undefined
  let interrupted = false
  const observation = openObservation(checked)
  try {
    assertRunnable(checked)
    if (checked.signal?.aborted) controller.abort(checked.signal.reason)
    else if (checked.signal) {
      checked.signal.addEventListener('abort', onAbort, { once: true })
      listening = true
    }
    const remaining = budget.remainingActiveMs()
    if (budget.limits.activeMs < Number.MAX_SAFE_INTEGER && remaining < TIMER_LIMIT) {
      timer = setTimeout(() => controller.abort(new ActiveLimitExceeded()), remaining)
    }
    budget.startRun()
    budgetStarted = true
    await recordOperationPhase(checked.stateRoot, checked.identity, 'running')
    throwIfControllerStopped(controller.signal)
    observation?.consumer.dispatch(observation.adapter.start())
    const config: RunnableConfig & { durability: 'sync' } = {
      recursionLimit: checked.recursionLimit,
      durability: 'sync',
      signal: controller.signal,
      configurable: {
        thread_id: langGraphThreadKey(checked.identity),
        checkpoint_ns: '',
        ...(checked.identity.checkpointId ? { checkpoint_id: checked.identity.checkpointId } : {})
      }
    }
    if (observation) {
      if (!graph.streamEvents) {
        throw new AppException({
          code: ErrorCodes.invalidRequest,
          msg: '工作流观察需要支持图事件流'
        })
      }
      const run = await graph.streamEvents(input, {
        ...config,
        callbacks: [observation.adapter.callbacks(observation.consumer.dispatch)],
        version: 'v3'
      })
      void run.output.catch(() => {})
      try {
        for await (const event of run) {
          throwIfControllerStopped(controller.signal)
          for (const observed of observation.adapter.adapt(event))
            observation.consumer.dispatch(observed)
        }
        output = (await run.output) as Output
        interrupted = run.interrupted
      } finally {
        await run.output.catch(() => {})
      }
    } else {
      output = await graph.invoke(input, config)
    }
    interrupted ||= isInterrupted(output)
    if (!interrupted) throwIfControllerStopped(controller.signal)
  } catch (error) {
    failed = error
    interrupted = classifyWorkflowError(error, controller.signal).category === 'interrupted'
  }
  const releaseErrors: unknown[] = []
  let settlementError: unknown
  if (timer) clearTimeout(timer)
  if (listening) checked.signal?.removeEventListener('abort', onAbort)
  if (budgetStarted) {
    try {
      budget.finishRun()
    } catch (error) {
      settlementError = error
    }
  }
  const phase = outcomePhase(failed, interrupted, controller.signal)
  if (budgetStarted) {
    try {
      await recordOperationPhase(checked.stateRoot, checked.identity, phase)
    } catch (error) {
      releaseErrors.push(error)
    }
  }
  if (observation) {
    const status = interrupted
      ? 'interrupted'
      : phase === 'cancelled'
        ? 'cancelled'
        : failed !== undefined || settlementError !== undefined || releaseErrors.length > 0
          ? 'failed'
          : 'succeeded'
    observation.consumer.dispatch(observation.adapter.finish(status))
    try {
      observation.adapter.release()
      observation.consumer.release()
    } catch (error) {
      releaseErrors.push(error)
    }
  }
  if (interrupted && settlementError === undefined && releaseErrors.length === 0) {
    return { status: 'interrupted', output: output as Output }
  }
  if (failed !== undefined || settlementError !== undefined || releaseErrors.length > 0) {
    const classified =
      failed === undefined
        ? new WorkflowError({
            category: interrupted ? 'interrupted' : 'executionFailed',
            msg: interrupted ? '工作流正在等待人工处理' : '工作流执行失败',
            cause: settlementError ?? releaseErrors[0]
          })
        : classifyWorkflowError(failed, controller.signal)
    throw new WorkflowError({
      category: interrupted ? 'interrupted' : classified.category,
      msg: interrupted ? '工作流正在等待人工处理' : classified.message,
      cause: failed ?? settlementError ?? releaseErrors[0],
      code: classified.code,
      settlementError,
      completed: releaseErrors.length > 0 ? releaseErrors.map(String) : undefined
    })
  }
  return { status: 'completed', output: output as Output }
}

/**
 * 在真正调用图之前拒绝取消、超时和已耗尽的预算。
 * @throws {WorkflowError} 不能开始执行。
 */
function assertRunnable(execution: WorkflowExecution): void {
  if (execution.signal?.aborted) {
    if (execution.signal.reason instanceof ActiveLimitExceeded) {
      throw new WorkflowError({
        category: 'timedOut',
        msg: '活跃执行时间已用尽',
        cause: execution.signal.reason
      })
    }
    throw new WorkflowError({
      category: 'cancelled',
      msg: '执行已取消',
      cause: execution.signal.reason
    })
  }
  if (
    execution.budget.limits.activeMs < Number.MAX_SAFE_INTEGER &&
    execution.budget.remainingActiveMs() <= 0
  ) {
    throw new WorkflowError({ category: 'timedOut', msg: '活跃执行时间已用尽' })
  }
}

/**
 * 接入已有的 Agent 观察订阅。没有订阅时不创建资源。
 * @returns 本次事件适配器和订阅消费者；未启用时为 undefined。
 */
function openObservation(execution: WorkflowExecution):
  | {
      adapter: LangChainEventStreamAdapter
      consumer: ReturnType<typeof createAgentStreamConsumer>
    }
  | undefined {
  const subscriptions = execution.observation?.subscriptions ?? []
  if (subscriptions.length === 0 && !execution.observation?.textDeltas) {
    return undefined
  }
  const consumer = createAgentStreamConsumer()
  const adapter = new LangChainEventStreamAdapter(
    execution.identity.operationId,
    execution.identity.operationId,
    execution.observation?.textDeltas ?? false
  )
  for (const subscription of subscriptions)
    consumer.subscribe(subscription.onEvent, subscription.signal)
  return { adapter, consumer }
}

/**
 * 把已中止的合成信号转成取消或超时。
 * @throws {ActiveLimitExceeded | WorkflowError} 信号已中止。
 */
function throwIfControllerStopped(signal: AbortSignal): void {
  if (!signal.aborted) return
  if (signal.reason instanceof ActiveLimitExceeded) throw signal.reason
  if (signal.reason instanceof WorkflowError) throw signal.reason
  throw new WorkflowError({ category: 'cancelled', msg: '执行已取消', cause: signal.reason })
}

/**
 * @param failed - 执行异常。没有异常时为 undefined。
 */
function outcomePhase(
  failed: unknown,
  interrupted: boolean,
  signal: AbortSignal
): WorkflowOperationPhase {
  if (interrupted) return 'waiting'
  if (failed === undefined) return 'finished'
  const classified = classifyWorkflowError(failed, signal)
  if (classified.category === 'cancelled') return 'cancelled'
  if (classified.category === 'interrupted') return 'waiting'
  return 'failed'
}
