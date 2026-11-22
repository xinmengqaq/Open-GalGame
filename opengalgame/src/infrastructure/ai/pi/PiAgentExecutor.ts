import type {
  Agent,
  AgentMessage,
  AgentOptions,
  AgentRequestUpdate,
  AgentTool,
  PrepareRequestContext,
  ThinkingLevel,
  ToolExecutionMode
} from '@earendil-works/pi-agent-core'
import type { Api, AssistantMessage, Model, SimpleStreamOptions } from '@earendil-works/pi-ai'

import { AppException } from '@common/errors/AppException'
import { ErrorCodes } from '@common/errors/ErrorCodes'
import type { ModelExecutionProfile } from '../config/modelExecutionConfig'
import type { AgentProgressObserver } from '../execution/AgentProgress'
import type { ExecutionBudget } from '../execution/ExecutionBudget'
import type { AgentStreamObservation } from '../streaming/AgentStreamEvent'
import { PiEventStream, type PiRunStatus } from './PiEventStream'
import type { PiModelRuntime } from './PiModelFactory'

/** 一次运行的业务身份；只用于事件关联，不写入模型请求。 */
export interface PiAgentRunIdentity {
  executionId: string
  agentId: string
  runId: string
}

/** 宿主可注入、可与预算组合的 Pi 钩子。 */
export interface PiAgentRunHooks {
  beforeToolCall?: NonNullable<AgentOptions['beforeToolCall']>
  afterToolCall?: NonNullable<AgentOptions['afterToolCall']>
  finishTurn?: NonNullable<AgentOptions['finishTurn']>
  transformContext?: NonNullable<AgentOptions['transformContext']>
  prepareRequest?: (
    context: PrepareRequestContext,
    signal?: AbortSignal
  ) => AgentRequestUpdate | undefined | Promise<AgentRequestUpdate | undefined>
  prepareNextTurnWithContext?: NonNullable<AgentOptions['prepareNextTurnWithContext']>
}

/** 场景工作流向 Pi 执行入口注入的一次运行输入。 */
export interface PiAgentRunRequest {
  /** 受信系统提示；与消息里的首条 system 消息冲突时拒绝。 */
  systemPrompt?: string
  /** 已有 transcript；可包含 system、user、assistant 和 toolResult。 */
  messages?: readonly AgentMessage[]
  /** 本次新增输入；省略时从 messages 末尾继续。 */
  prompt?: string | AgentMessage
  /** 允许模型调用的宿主工具。 */
  tools: readonly AgentTool[]
  /** 取消信号；必须由调用方持有。 */
  signal: AbortSignal
  identity: PiAgentRunIdentity
  budget?: ExecutionBudget
  progress?: AgentProgressObserver
  observation?: AgentStreamObservation
  /** 默认顺序执行，避免同一候选上的并发写入。 */
  toolExecution?: ToolExecutionMode
  /** 默认关闭推理等级；模型能力由连接设置决定，不在这里猜测。 */
  thinkingLevel?: ThinkingLevel
  hooks?: PiAgentRunHooks
  sessionId?: string
  onPayload?: SimpleStreamOptions['onPayload']
  onResponse?: SimpleStreamOptions['onResponse']
  onProviderStreamEvent?: SimpleStreamOptions['onProviderStreamEvent']
}

/** 聚合后的实际 token 用量；不代表预算已结算。 */
export interface PiAgentRunUsage {
  inputTokens: number
  outputTokens: number
  totalTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
}

/** 一次 Pi 运行的最终事实。模型和工具失败以状态返回，不在这里改写为业务错误。 */
export interface PiAgentRunResult {
  status: PiRunStatus
  stopReason: AssistantMessage['stopReason'] | 'none'
  messages: AgentMessage[]
  assistant?: AssistantMessage
  usage: PiAgentRunUsage
  errorMessage?: string
  error?: unknown
  durationMs: number
}

export interface PiAgentExecutorOptions {
  runtime: PiModelRuntime
  createAgent: (options: AgentOptions) => Agent
  now?: () => number
}

/**
 * 绑定一次已保存连接设置的 Pi 执行器。
 *
 * 每次 `run` 创建独立的 Pi Agent，不共享 transcript；执行器本身可复用。
 * 工具授权、读写范围和候选发布仍由调用方提供，执行器只负责工具循环和事件观察。
 */
export class PiAgentExecutor {
  private readonly runtime: PiModelRuntime
  private readonly createAgent: (options: AgentOptions) => Agent
  private readonly now: () => number

  constructor(options: PiAgentExecutorOptions) {
    this.runtime = options.runtime
    this.createAgent = options.createAgent
    this.now = options.now ?? Date.now
  }

  /** 本次执行的有效模型配置，不含密钥。 */
  get profile(): ModelExecutionProfile {
    return this.runtime.profile
  }

  /** 本次模型描述，不含密钥。 */
  get model(): Model<Api> {
    return this.runtime.model
  }

  /**
   * 执行一次 Pi 工具循环。
   * @param request - 系统提示、消息、工具、取消信号和观察入口。
   * @returns 最终 transcript、状态和用量；模型失败不抛出。
   * @throws {AppException} 请求形状不合法。
   */
  async run(request: PiAgentRunRequest): Promise<PiAgentRunResult> {
    const input = validateRequest(request)
    const events = new PiEventStream({
      executionId: input.identity.executionId,
      agentId: input.identity.agentId,
      runId: input.identity.runId,
      modelName: this.runtime.model.id,
      ...(input.observation ? { observation: input.observation } : {}),
      ...(input.progress ? { progress: input.progress } : {}),
      ...(input.budget ? { budget: input.budget } : {}),
      now: this.now
    })
    events.start()
    const startedAt = this.now()

    if (input.signal.aborted) {
      events.finish('cancelled')
      return {
        status: 'cancelled',
        stopReason: 'none',
        messages: [],
        usage: emptyRunUsage(),
        durationMs: Math.max(0, this.now() - startedAt)
      }
    }

    let terminalError: unknown
    let agent: Agent | undefined
    let abortedDuringRun = false
    // 在创建 Agent（含动态模块加载）之前就监听取消；创建窗口内的取消不能在之后被忽略。
    const onAbort = (): void => {
      abortedDuringRun = true
      agent?.abort()
    }
    input.signal.addEventListener('abort', onAbort, { once: true })
    try {
      agent = this.createAgent(
        this.createAgentOptions(
          input,
          () => terminalError,
          (error) => {
            terminalError = error
            agent?.abort()
          }
        )
      )
    } catch (error) {
      input.signal.removeEventListener('abort', onAbort)
      events.finish('failed', '模型运行无法创建')
      return {
        status: 'failed',
        stopReason: 'none',
        messages: [],
        usage: emptyRunUsage(),
        errorMessage: '模型运行无法创建',
        error,
        durationMs: Math.max(0, this.now() - startedAt)
      }
    }
    if (abortedDuringRun || input.signal.aborted) agent.abort()

    const unsubscribe = agent.subscribe((event, signal) => {
      if (
        event.type === 'message_end' &&
        event.message.role === 'assistant' &&
        input.budget &&
        event.message.usage.totalTokens > 0
      ) {
        try {
          input.budget.consumeTokenUsage({
            inputTokens: event.message.usage.input,
            outputTokens: event.message.usage.output,
            totalTokens: event.message.usage.totalTokens
          })
        } catch (error) {
          if (terminalError === undefined) {
            terminalError = error
            agent?.abort()
          }
        }
      }
      events.handle(event, signal)
    })
    try {
      if (!abortedDuringRun && !input.signal.aborted) {
        if (input.prompt === undefined) await agent.continue()
        else if (typeof input.prompt === 'string') await agent.prompt(input.prompt)
        else await agent.prompt(input.prompt)
      }
    } catch (error) {
      if (!abortedDuringRun && terminalError === undefined) terminalError = error
    } finally {
      input.signal.removeEventListener('abort', onAbort)
      unsubscribe()
      await agent.waitForIdle().catch(() => undefined)
    }

    const messages = agent.state.messages.slice()
    const assistant = lastAssistant(messages)
    const status = runStatus(assistant, terminalError, abortedDuringRun)
    const errorMessage = runErrorMessage(status, assistant, terminalError)
    // Pi 流适配器把 HTTP 失败压成可展示文案并丢失状态码；执行边界用请求观察位恢复分类事实。
    const providerStatus =
      status === 'failed' && terminalError === undefined
        ? this.runtime.lastHttpStatus?.()
        : undefined
    events.finish(status, status === 'failed' ? '模型执行失败' : undefined)
    return {
      status,
      stopReason: assistant?.stopReason ?? 'none',
      messages,
      ...(assistant ? { assistant } : {}),
      usage: aggregateUsage(messages),
      ...(errorMessage !== undefined ? { errorMessage } : {}),
      ...(terminalError !== undefined
        ? { error: terminalError }
        : providerStatus !== undefined
          ? { error: modelHttpError(providerStatus) }
          : {}),
      durationMs: Math.max(0, this.now() - startedAt)
    }
  }

  /**
   * 组装 Pi Agent 选项：固定模型和已注入输入，组合预算及宿主钩子。
   */
  private createAgentOptions(
    input: PiAgentRunRequest & { tools: AgentTool[] },
    readTerminalError: () => unknown,
    failBudget: (error: unknown) => void
  ): AgentOptions {
    const initialMessages = input.messages ? [...input.messages] : []
    const systemPrompt = input.systemPrompt
    const hooks = input.hooks
    const budget = input.budget
    return {
      streamFn: this.runtime.streamFn,
      initialState: {
        model: this.runtime.model,
        tools: [...input.tools],
        thinkingLevel: input.thinkingLevel ?? 'off',
        ...(systemPrompt !== undefined ? { systemPrompt } : {}),
        ...(initialMessages.length > 0 ? { messages: initialMessages } : {})
      },
      identity: { attribution: null },
      toolExecution: input.toolExecution ?? 'sequential',
      ...(input.sessionId !== undefined ? { sessionId: input.sessionId } : {}),
      beforeToolCall: async (context, signal) => {
        if (signal?.aborted) return { block: true, reason: '执行已取消', terminate: true }
        const caller = hooks?.beforeToolCall
          ? await hooks.beforeToolCall(context, signal)
          : undefined
        if (caller?.block) return caller
        if (budget) {
          try {
            if (budget.remainingToolCalls() <= 0)
              throw new AppException({
                code: ErrorCodes.invalidRequest,
                msg: '工具调用次数已用尽'
              })
            budget.assertToolAvailable()
            budget.consumeToolCall()
          } catch (error) {
            if (readTerminalError() === undefined) failBudget(error)
            return { block: true, reason: '执行预算已用尽', terminate: true }
          }
        }
        return caller
      },
      afterToolCall: async (context, signal) => {
        const caller = hooks?.afterToolCall ? await hooks.afterToolCall(context, signal) : undefined
        if (signal?.aborted) {
          return {
            isError: true,
            content: [{ type: 'text', text: '执行已取消，结果未确认' }],
            terminate: true
          }
        }
        return caller
      },
      ...(hooks?.finishTurn ? { finishTurn: hooks.finishTurn } : {}),
      ...(hooks?.transformContext ? { transformContext: hooks.transformContext } : {}),
      ...(hooks?.prepareNextTurnWithContext
        ? { prepareNextTurnWithContext: hooks.prepareNextTurnWithContext }
        : {}),
      prepareRequest: async (context, signal) => {
        if (budget) {
          if (budget.remainingModelAttempts() <= 0)
            throw new AppException({
              code: ErrorCodes.invalidRequest,
              msg: '模型请求次数已用尽'
            })
          budget.assertModelAvailable()
          budget.consumeModelAttempt()
        }
        return hooks?.prepareRequest ? await hooks.prepareRequest(context, signal) : undefined
      },
      ...(input.onPayload ? { onPayload: input.onPayload } : {}),
      ...(input.onResponse ? { onResponse: input.onResponse } : {}),
      ...(input.onProviderStreamEvent ? { onProviderStreamEvent: input.onProviderStreamEvent } : {})
    }
  }
}

/** 校验并复制一次运行的输入；不修改调用方对象。 */
function validateRequest(request: PiAgentRunRequest): PiAgentRunRequest & { tools: AgentTool[] } {
  if (!request || typeof request !== 'object') throw invalidRequest('运行请求不能为空')
  if (!request.signal || typeof request.signal.aborted !== 'boolean')
    throw invalidRequest('运行请求缺少取消信号')
  validateIdentity(request.identity)
  const systemPrompt = request.systemPrompt
  if (systemPrompt !== undefined && systemPrompt.trim().length === 0)
    throw invalidRequest('系统提示词不能为空')
  if (typeof request.prompt === 'string' && request.prompt.trim().length === 0)
    throw invalidRequest('本次输入不能为空')
  const messages = request.messages ?? []
  if (!Array.isArray(messages)) throw invalidRequest('消息列表格式不正确')
  if (messages.length > 0 && messages[0]?.role === 'system' && systemPrompt !== undefined)
    throw invalidRequest('系统提示词与消息中的首条 system 消息只能保留一处')
  if (request.prompt === undefined) {
    if (messages.length === 0) throw invalidRequest('运行请求缺少输入消息')
    const last = messages[messages.length - 1]
    if (!last || (last.role !== 'user' && last.role !== 'toolResult'))
      throw invalidRequest('继续运行需要以用户或工具结果消息结束')
  }
  const tools = request.tools
  if (!Array.isArray(tools)) throw invalidRequest('工具列表格式不正确')
  const names = new Set<string>()
  for (const tool of tools) {
    if (!tool || typeof tool.name !== 'string' || tool.name.trim().length === 0)
      throw invalidRequest('工具名称不能为空')
    if (names.has(tool.name)) throw invalidRequest('工具名称不能重复')
    names.add(tool.name)
  }
  return { ...request, tools: [...tools] }
}

function validateIdentity(identity: PiAgentRunIdentity | undefined): void {
  if (!identity || typeof identity !== 'object') throw invalidRequest('运行身份不能为空')
  for (const value of [identity.executionId, identity.agentId, identity.runId]) {
    if (typeof value !== 'string' || value.trim().length === 0)
      throw invalidRequest('运行身份字段不能为空')
  }
}

/** @returns 最后一条 assistant 消息；没有时 undefined。 */
function lastAssistant(messages: readonly AgentMessage[]): AssistantMessage | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message.role === 'assistant') return message
  }
  return undefined
}

/**
 * 只按最后一个 assistant 终态和宿主记录的失败判定结果。
 * 用户取消与预算失败不互相冒充。
 */
function runStatus(
  assistant: AssistantMessage | undefined,
  terminalError: unknown,
  abortedDuringRun: boolean
): PiRunStatus {
  if (terminalError !== undefined) return 'failed'
  if (abortedDuringRun) return 'cancelled'
  if (!assistant) return 'failed'
  if (assistant.stopReason === 'aborted') return 'cancelled'
  if (assistant.stopReason === 'error') return 'failed'
  return 'succeeded'
}

/** @returns 不含密钥的结果说明；成功或取消时省略。 */
function runErrorMessage(
  status: PiRunStatus,
  assistant: AssistantMessage | undefined,
  terminalError: unknown
): string | undefined {
  if (status !== 'failed') return undefined
  if (terminalError instanceof AppException) return terminalError.message
  if (terminalError instanceof Error && terminalError.message.trim().length > 0)
    return terminalError.message
  if (assistant?.errorMessage && assistant.errorMessage.trim().length > 0)
    return assistant.errorMessage
  return '模型执行失败'
}

/** 汇总所有 assistant 消息的实际用量；缺失字段按 0 处理，不推断。 */
function aggregateUsage(messages: readonly AgentMessage[]): PiAgentRunUsage {
  const usage = emptyRunUsage()
  for (const message of messages) {
    if (message.role !== 'assistant') continue
    usage.inputTokens += message.usage.input
    usage.outputTokens += message.usage.output
    usage.totalTokens += message.usage.totalTokens
    usage.cacheReadTokens += message.usage.cacheRead
    usage.cacheWriteTokens += message.usage.cacheWrite
  }
  return usage
}

/** 已确认的模型 HTTP 失败；状态码供统一失败分类，不含响应正文或请求头。 */
function modelHttpError(status: number): Error {
  return Object.assign(new Error(`模型请求失败（HTTP ${status}）`), { status })
}

function emptyRunUsage(): PiAgentRunUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0
  }
}

function invalidRequest(msg: string): AppException {
  return new AppException({ code: ErrorCodes.invalidRequest, msg })
}
