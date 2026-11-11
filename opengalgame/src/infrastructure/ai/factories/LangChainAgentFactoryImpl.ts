import { createAgent, type ReactAgent } from 'langchain'
import { mergeConfigs, type RunnableConfig } from '@langchain/core/runnables'
import { getConfig } from '@langchain/langgraph'

import { AppException } from '@common/errors/AppException'
import { ErrorCodes } from '@common/errors/ErrorCodes'
import { assertAgentId } from '../prompts/PromptReference'
import {
  assembleAgentExecutionProfile,
  type AgentExecutionOverride
} from '../config/agentExecutionConfig'
import { createAgentMiddleware } from '../middleware/createAgentMiddleware'
import { normalizeAgentError } from '../middleware/retryPolicy'
import type { LangChainModelFactory } from '../models/LangChainModelFactory'
import type { FilePromptLoader } from '../prompts/FilePromptLoader'
import type { AgentExecution, AgentRunContext } from '../agents/AgentExecution'
import type { ExecutionBudgetCeiling } from '../execution/ExecutionBudget'
import {
  executionScope,
  agentInvocationScope,
  type ExecutionScope
} from '../execution/executionScope'
import { ActiveLimitExceeded, AttemptTimedOut, throwIfStopped } from '../execution/executionErrors'
import { InformationGainTracker } from '../execution/InformationGainTracker'
import { createAgentStreamConsumer } from '../streaming/AgentStreamConsumer'
import {
  createConsoleAgentStreamLogger,
  type ConsoleAgentStreamLoggerOptions
} from '../streaming/ConsoleAgentStreamLogger'
import { LangChainEventStreamAdapter } from '../streaming/LangChainEventStreamAdapter'
import { settleAgentRunProjections } from '../streaming/settleAgentRunProjections'
import type { AgentFactory, AgentCreationRequest } from './AgentFactory'

/** Agent 图的技术步数上限。只阻止失控递归，不表示模型、工具或修正额度。 */
const agentGraphStepCeiling = 4096
import type { Agent } from '../agents/Agent'
import type { AgentImplementation } from '../agents/AgentDefinition'

export class LangChainAgentFactoryImpl implements AgentFactory {
  constructor(
    private readonly models: LangChainModelFactory,
    private readonly prompts: FilePromptLoader,
    private readonly consoleOptions: ConsoleAgentStreamLoggerOptions = { enabled: false }
  ) {}

  /**
   * 读取创建定义并返回实现类实例。实例保持创建时读到的提示词正文。
   * @param request - 本次覆盖、用户级参数、模型覆盖和可选检查点。
   * @throws {AppException} 标识、提示词、配置或模型设置无效。
   */
  async create<Input, Output>(
    implementation: AgentImplementation<Input, Output>,
    request?: AgentCreationRequest
  ): Promise<Agent<Input, Output>> {
    const definition = implementation.definition
    assertAgentId(definition.id)
    const profile = assembleAgentExecutionProfile({
      override: request?.override,
      definition: definition.execution,
      user: request?.user
    })
    const created = await this.models.createModel(request?.model)
    const loaded = await this.prompts.load(definition.prompt)
    const tools = [...definition.createTools()]
    bindAttemptSignal(created.model)
    const middleware = createAgentMiddleware({
      model: created.model,
      profile,
      contextWindow: created.profile.contextWindow,
      maxOutputTokens: created.profile.maxOutputTokens,
      ...(created.profile.requestTimeoutMs !== undefined
        ? { requestTimeoutMs: created.profile.requestTimeoutMs }
        : {}),
      systemPrompt: loaded.body,
      tools,
      extra: definition.middleware
    })
    const executor = createAgent({
      model: created.model,
      tools,
      systemPrompt: loaded.body,
      middleware,
      name: definition.id,
      ...(definition.responseFormat !== undefined
        ? { responseFormat: definition.responseFormat }
        : {}),
      ...(definition.stateSchema !== undefined ? { stateSchema: definition.stateSchema } : {}),
      ...(definition.contextSchema !== undefined
        ? { contextSchema: definition.contextSchema }
        : {}),
      ...(request?.checkpointer !== undefined ? { checkpointer: request.checkpointer } : {})
    })
    const configured = executor.withConfig({ recursionLimit: agentGraphStepCeiling })
    const controls: ExecutorControls = {
      agentId: definition.id,
      modelName: created.profile.model,
      consoleOptions: this.consoleOptions,
      ...(created.profile.requestTimeoutMs !== undefined
        ? { requestTimeoutMs: created.profile.requestTimeoutMs }
        : {}),
      ...(profile.toolTimeoutMs !== undefined ? { toolTimeoutMs: profile.toolTimeoutMs } : {}),
      toolResultCharLimit: profile.toolResultCharLimit,
      ceiling: explicitExecutionCeiling({
        override: request?.override,
        definition: definition.execution,
        user: request?.user,
        ...(profile.cumulativeTokenLimit !== undefined
          ? { tokens: profile.cumulativeTokenLimit }
          : {})
      }),
      ...(definition.responseFormat !== undefined
        ? { responseFormat: definition.responseFormat }
        : {})
    }
    const instance = new implementation(scopeExecutor(configured, controls))
    const invoke = instance.invoke.bind(instance)
    instance.invoke = (input, execution) =>
      invokeObserved(() => invoke(input, execution), execution, controls)
    return instance
  }
}

/** 让模型调用带上本次尝试的取消信号。摘要和正式请求都走这个入口。 */
function bindAttemptSignal(model: { invoke: (...args: never[]) => Promise<unknown> }): void {
  const invoke = model.invoke.bind(model)
  model.invoke = (async (input: never, options?: { signal?: AbortSignal }) => {
    const attempt = executionScope.getStore()?.attemptSignal
    const signals = [options?.signal, attempt].filter(
      (signal): signal is AbortSignal => signal !== undefined
    )
    const signal = signals.length > 1 ? AbortSignal.any(signals) : signals[0]
    return invoke(input, { ...options, signal } as never)
  }) as typeof model.invoke
}

/**
 * 只收紧调用方明确写出的次数和时间上限。建议默认值不进入天花板。
 * @returns 可应用到本次预算的上限。
 */
function explicitExecutionCeiling(input: {
  override?: AgentExecutionOverride
  definition?: AgentExecutionOverride
  user?: AgentExecutionOverride
  tokens?: number
}): ExecutionBudgetCeiling {
  const modelAttempts = explicitLimit(input, 'modelAttemptLimit')
  const toolCalls = explicitLimit(input, 'toolCallLimit')
  const activeMs = explicitLimit(input, 'activeLimitMs')
  return {
    ...(modelAttempts !== undefined ? { modelAttempts } : {}),
    ...(toolCalls !== undefined ? { toolCalls } : {}),
    ...(activeMs !== undefined ? { activeMs } : {}),
    ...(input.tokens !== undefined ? { tokens: input.tokens } : {})
  }
}

/** @returns 三层里最先明确给出的上限；都没写时为 undefined。 */
function explicitLimit(
  input: {
    override?: AgentExecutionOverride
    definition?: AgentExecutionOverride
    user?: AgentExecutionOverride
  },
  key: 'modelAttemptLimit' | 'toolCallLimit' | 'activeLimitMs'
): number | undefined {
  if (input.override?.[key] !== undefined) return input.override[key]
  if (input.definition?.[key] !== undefined) return input.definition[key]
  return input.user?.[key]
}

interface ExecutorControls {
  agentId: string
  modelName: string
  consoleOptions: ConsoleAgentStreamLoggerOptions
  requestTimeoutMs?: number
  toolTimeoutMs?: number
  toolResultCharLimit: number
  ceiling: ExecutionBudgetCeiling
  responseFormat?: unknown
}

/**
 * 完整 Agent 调用结束后记录唯一终态，包含实现类的输出转换失败。
 * @throws 实现类调用的原始异常，观察逻辑不替换该异常。
 */
async function invokeObserved<Output>(
  invoke: () => Promise<Output>,
  execution: AgentExecution,
  controls: ExecutorControls
): Promise<Output> {
  const consumer = createAgentStreamConsumer()
  const adapter = new LangChainEventStreamAdapter(
    execution.identity.executionId,
    controls.agentId,
    execution.observation?.textDeltas ?? false,
    controls.modelName
  )
  for (const subscription of execution.observation?.subscriptions ?? [])
    consumer.subscribe(subscription.onEvent, subscription.signal)
  consumer.subscribe(createConsoleAgentStreamLogger(controls.consoleOptions))
  const invocation = { consumer, adapter, interrupted: false }
  consumer.dispatch(adapter.start())
  let status: 'succeeded' | 'interrupted' | 'failed' | 'cancelled' = 'failed'
  try {
    const output = await agentInvocationScope.run(invocation, invoke)
    status = invocation.interrupted ? 'interrupted' : 'succeeded'
    return output
  } catch (error) {
    if (isUserCancelled(execution.signal)) status = 'cancelled'
    throw error
  } finally {
    consumer.dispatch(adapter.finish(status))
    consumer.release()
    adapter.release()
  }
}

/**
 * 真实用户信号取消与内部执行保护失败分开。
 * @param signal - 调用方的取消信号。
 * @returns 是否发生真实用户取消。
 */
function isUserCancelled(signal?: AbortSignal): boolean {
  return (
    signal?.aborted === true &&
    !(
      signal.reason instanceof ActiveLimitExceeded ||
      signal.reason instanceof AttemptTimedOut ||
      signal.reason instanceof AppException
    )
  )
}

/**
 * @returns 保持原方法、只替换 invoke 的执行器。
 */
function scopeExecutor(executor: ReactAgent, controls: ExecutorControls): ReactAgent {
  return new Proxy(executor, {
    get(target, property, receiver) {
      if (property === 'invoke') {
        return (state: unknown, config?: RunnableConfig & { context?: AgentRunContext }) =>
          invokeScoped(target, state, config, controls)
      }
      const value = Reflect.get(target, property, receiver)
      return typeof value === 'function' ? value.bind(target) : value
    }
  }) as ReactAgent
}

/**
 * 外层尚未计量时才开始并结算预算。工作流已经开始的同一份预算只沿用，不另开一段。
 * @param config - 本次上下文、取消信号和检查点定位。
 * @throws {ActiveLimitExceeded | AppException} 活跃时间用尽或执行失败。清理失败会保留原始原因。
 */
async function invokeScoped(
  executor: ReactAgent,
  state: unknown,
  config: (RunnableConfig & { context?: AgentRunContext }) | undefined,
  controls: ExecutorControls
): Promise<unknown> {
  const invocation = agentInvocationScope.getStore()
  if (!invocation)
    throw new AppException({ code: ErrorCodes.internalError, msg: 'Agent 执行作用域缺失' })
  const { consumer, adapter } = invocation
  const budget = config?.context?.budget
  let budgetStarted = false
  const userSignal = config?.signal
  const controller = new AbortController()
  const onAbort = (): void => controller.abort(userSignal?.reason)
  if (userSignal?.aborted) controller.abort(userSignal.reason)
  else userSignal?.addEventListener('abort', onAbort, { once: true })
  let activeTimer: ReturnType<typeof setTimeout> | undefined
  const runContext = copyRunContext(config?.context)
  const scope: ExecutionScope = {
    context: runContext,
    ...(controls.requestTimeoutMs !== undefined
      ? { requestTimeoutMs: controls.requestTimeoutMs }
      : {}),
    ...(controls.toolTimeoutMs !== undefined ? { toolTimeoutMs: controls.toolTimeoutMs } : {}),
    toolResultCharLimit: controls.toolResultCharLimit,
    summaryOutcome: 'idle',
    ...(controls.responseFormat !== undefined ? { responseFormat: controls.responseFormat } : {}),
    informationGain: new InformationGainTracker()
  }
  let result: unknown
  let failed: unknown
  try {
    budget?.applyCeiling(controls.ceiling)
    if (budget && !budget.hasOpenRun()) {
      budget.startRun()
      budgetStarted = true
    }
    const remaining = budget?.remainingActiveMs()
    const activeLimited = budget !== undefined && budget.limits.activeMs < Number.MAX_SAFE_INTEGER
    if (activeLimited && remaining !== undefined && remaining <= 0) {
      controller.abort(new ActiveLimitExceeded())
    } else if (activeLimited && remaining !== undefined && remaining < 2_147_483_647) {
      activeTimer = setTimeout(() => controller.abort(new ActiveLimitExceeded()), remaining)
    }
    result = await executionScope.run(scope, async () => {
      throwIfStopped(controller.signal)
      const namespace = getConfig()?.configurable?.checkpoint_ns ?? ''
      let nestedOutput: unknown
      const run = await executor.streamEvents(state as never, {
        ...mergeConfigs({ callbacks: getConfig()?.callbacks }, config, {
          callbacks: [adapter.callbacks(consumer.dispatch)]
        }),
        ...(runContext !== undefined ? { context: runContext } : {}),
        signal: controller.signal,
        version: 'v3'
      })
      const output = run.output
      void output.catch(() => {})
      const toolOutputs = settleAgentRunProjections(run)
      void toolOutputs.catch(() => {})
      try {
        for await (const event of run) {
          throwIfStopped(controller.signal)
          if (event.method === 'values' && event.params.namespace.join('|') === namespace) {
            nestedOutput = event.params.data
          }
          for (const observed of adapter.adapt(event)) consumer.dispatch(observed)
        }
        const rootOutput = await output
        const final = namespace === '' ? rootOutput : nestedOutput
        throwIfStopped(controller.signal)
        if (final === undefined)
          throw new AppException({ code: ErrorCodes.internalError, msg: 'Agent 未返回最终状态' })
        invocation.interrupted ||= run.interrupted
        return final
      } finally {
        await output.catch(() => {})
        await toolOutputs.catch(() => {})
      }
    })
  } catch (error) {
    failed = error
  }
  const cleanup: unknown[] = []
  if (activeTimer) clearTimeout(activeTimer)
  userSignal?.removeEventListener('abort', onAbort)
  try {
    if (budgetStarted) budget?.finishRun()
  } catch (error) {
    cleanup.push(error)
  }
  const isFailed = failed !== undefined || cleanup.length > 0
  if (isFailed) throw settleExecutionError(failed, cleanup)
  return result
}

/**
 * 复制本次运行上下文，供摘要临时参数使用。预算对象仍是调用方的那一个。
 * @param context - 调用方传入的运行上下文。
 * @returns 新的普通对象；没有上下文时为 undefined。
 */
function copyRunContext(context: AgentRunContext | undefined): AgentRunContext | undefined {
  if (context === undefined) return undefined
  return { ...context }
}

/**
 * 把执行失败和清理失败收成项目异常，并保留原始原因。
 * @param failed - 执行过程中的失败。成功时为 undefined。
 * @param cleanup - 预算结算失败。
 * @returns 可交给调用方的异常。
 */
function settleExecutionError(failed: unknown, cleanup: readonly unknown[]): AppException {
  const normalized = failed === undefined ? undefined : normalizeAgentError(failed)
  if (cleanup.length === 0 && normalized) return normalized
  const cause =
    failed === undefined
      ? cleanup.length === 1
        ? cleanup[0]
        : new AggregateError(cleanup)
      : new AggregateError([failed, ...cleanup])
  return new AppException({
    code: normalized?.code ?? ErrorCodes.internalError,
    msg: normalized?.message ?? '执行清理失败',
    cause,
    ...(normalized?.diagnosticCategory ? { diagnosticCategory: normalized.diagnosticCategory } : {})
  })
}
