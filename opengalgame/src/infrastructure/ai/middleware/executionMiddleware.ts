import { RemoveMessage, type BaseMessage } from '@langchain/core/messages'
import { REMOVE_ALL_MESSAGES } from '@langchain/langgraph'
import { AIMessage, type AnyAgentMiddleware, ToolMessage, createMiddleware } from 'langchain'

import { AppException } from '@common/errors/AppException'
import { ErrorCodes } from '@common/errors/ErrorCodes'
import { agentRunContextSchema } from '../agents/AgentRunContextSchema'
import { notifyAgentProgress } from '../execution/AgentProgress'
import { evaluateContextBudget } from '../context/contextBudget'
import type { ExternalContentStore } from '../context/FileContextContentStore'
import { ExecutionBudget } from '../execution/ExecutionBudget'
import { AttemptTimedOut, OutputTruncated, throwIfStopped } from '../execution/executionErrors'
import { executionScope, type ExecutionScope } from '../execution/executionScope'
import { countsAsErrorAttempt, observeModelCallFailure } from './retryPolicy'

/**
 * @throws {AppException} 上下文里没有预算对象。
 */
export function readBudget(context: unknown): ExecutionBudget {
  if (!context || typeof context !== 'object' || !('budget' in context)) {
    throw new AppException({ code: ErrorCodes.invalidRequest, msg: '本次执行缺少运行上下文' })
  }
  if (!(context.budget instanceof ExecutionBudget)) {
    throw new AppException({ code: ErrorCodes.invalidRequest, msg: '本次执行缺少运行上下文' })
  }
  return context.budget
}

/** 在模型调用前拒绝已经耗尽的预算。不消耗尚未发生的调用。 */
export function createBudgetGateMiddleware(): AnyAgentMiddleware {
  return createMiddleware({
    name: 'budgetGate',
    contextSchema: agentRunContextSchema,
    beforeModel: (_state, runtime) => {
      readBudget(runtime.context).assertModelAvailable()
    }
  })
}

/**
 * 按模型窗口、输出预留和安全余量裁剪消息。必需内容放不下时失败。
 * @throws {AppException} 必需内容超过可用输入空间。
 */
export interface ContextGuardInput {
  systemPrompt: string
  tools: readonly unknown[]
  contextWindow: number
  maxOutputTokens: number
  safetyFraction: number
  inputBudgetTokens: number
}

/**
 * 在摘要和工具结果清理前确认必需内容放得下，并让原生摘要留住这些消息。
 * 摘要的保留条数写进本次运行上下文对象本身，库的摘要中间件从同一个对象读取；
 * 钩子拿到的是按声明的字段解析出的副本，因此这里仍使用本次 invoke 的作用域取那个对象。
 * @throws {AppException} 必需内容超过可用输入空间。
 */
export function createRequiredContentMiddleware(input: ContextGuardInput): AnyAgentMiddleware {
  return createMiddleware({
    name: 'requiredContent',
    contextSchema: agentRunContextSchema,
    beforeModel: (state, runtime) => {
      const scope = executionScope.getStore()
      const requiredIds = readRequiredIds(runtime.context)
      const described = describeMessages(state.messages, requiredIds)
      if (described.some((message) => message.required)) {
        evaluateContextBudget(budgetRequest(input, input.systemPrompt, described))
      }
      const earliest = earliestProtectedIndex(state.messages, requiredIds)
      if (earliest !== undefined) {
        rememberKeep(scope?.context, state.messages.length - earliest)
      }
      if (scope) {
        scope.requiredMessages = state.messages.filter((message) =>
          isRequired(message, requiredIds)
        )
      }
      return undefined
    }
  })
}

/**
 * 按模型窗口、输出预留和安全余量裁剪消息。必需内容放不下时失败。
 * @throws {AppException} 必需内容超过可用输入空间。
 */
export function createContextGuardMiddleware(input: ContextGuardInput): AnyAgentMiddleware {
  return createMiddleware({
    name: 'contextBudget',
    contextSchema: agentRunContextSchema,
    beforeModel: (state, runtime) => {
      const requiredIds = readRequiredIds(runtime.context)
      const described = describeMessages(state.messages, requiredIds)
      const decision = evaluateContextBudget(budgetRequest(input, input.systemPrompt, described))
      return trimmedMessages(described, decision.messages)
    }
  })
}

/**
 * 结构化输出默认由库把 tool_choice 提升为 any/required；部分 thinking 模型只接受 auto。
 * 只在本轮带结构化输出时放宽为 auto，让模型自行决定何时提交结果。
 */
export function createToolChoiceRelaxMiddleware(): AnyAgentMiddleware {
  return createMiddleware({
    name: 'toolChoiceRelax',
    contextSchema: agentRunContextSchema,
    wrapModelCall: async (request, handler) => {
      if (request.responseFormat === undefined) return handler(request)
      return handler({ ...request, toolChoice: 'auto' })
    }
  })
}

/**
 * 核对最终模型请求。附加中间件改过的提示词、消息、工具和输出模式仍受限制。
 * @throws {AppException} 最终请求超过可用输入空间。
 */
export function createFinalRequestGuard(input: ContextGuardInput): AnyAgentMiddleware {
  return createMiddleware({
    name: 'finalRequestGuard',
    contextSchema: agentRunContextSchema,
    wrapModelCall: async (request, handler) => {
      const scope = executionScope.getStore()
      const messages = withRequiredMessages(request.messages, scope?.requiredMessages)
      const requiredIds = readRequiredIds(request.runtime.context)
      const described = describeMessages(messages, requiredIds)
      const prompt = request.systemPrompt || request.systemMessage?.text || ''
      const schemaText = responseFormatText(request.responseFormat)
      const decision = evaluateContextBudget(
        budgetRequest(
          input,
          schemaText.length > 0 ? `${prompt}\n${schemaText}` : prompt,
          described,
          request.tools
        )
      )
      const kept = trimmedMessages(described, decision.messages)
      return handler({
        ...request,
        messages: kept?.messages.slice(1) ?? messages
      })
    }
  })
}

/**
 * 统计每一次实际进入模型的尝试，包括失败尝试。
 * @throws {AppException} 次数、时间或累计 token 已经用尽。
 */
export function createAttemptMeterMiddleware(): AnyAgentMiddleware {
  return createMiddleware({
    name: 'attemptMeter',
    contextSchema: agentRunContextSchema,
    wrapModelCall: async (request, handler) => {
      const budget = readBudget(request.runtime.context)
      budget.assertModelAvailable()
      budget.consumeModelAttempt()
      const progress = request.runtime.context.progress
      notifyAgentProgress(progress, {
        kind: 'model-start',
        at: Date.now(),
        usage: budget.usage
      })
      try {
        const response = await handler(request)
        const usage = readTokenUsage(response)
        if (usage) budget.consumeTokenUsage(usage)
        notifyAgentProgress(progress, {
          kind: 'model-end',
          at: Date.now(),
          usage: budget.usage
        })
        assertCompleteModelResponse(response)
        return response
      } catch (error) {
        const failedUsage = readTokenUsage(error)
        if (failedUsage) budget.consumeTokenUsage(failedUsage)
        notifyAgentProgress(progress, {
          kind: 'model-end',
          at: Date.now(),
          usage: budget.usage
        })
        if (isTruncatedModelResponse(error)) throw new OutputTruncated(error)
        const observed = observeModelCallFailure(error)
        recordConfirmedFailure(budget, observed)
        throw observed
      }
    }
  })
}

/**
 * 只在本次明确给出单次超时时安装计时器。缺省表示不设模型调用时限。
 * @throws {AttemptTimedOut} 已配置的单次时限到点。
 */
export function createModelTimeoutMiddleware(): AnyAgentMiddleware {
  return createMiddleware({
    name: 'modelTimeout',
    contextSchema: agentRunContextSchema,
    wrapModelCall: async (request, handler) => {
      const scope = executionScope.getStore()
      const timeoutMs = scope?.requestTimeoutMs
      if (timeoutMs === undefined) return handler(request)
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(new AttemptTimedOut()), timeoutMs)
      if (scope) scope.attemptSignal = controller.signal
      try {
        return await handler(request)
      } finally {
        clearTimeout(timer)
        if (scope) scope.attemptSignal = undefined
      }
    }
  })
}

/**
 * 统计工具调用，施加超时，并把超出上限的结果外置。
 * @throws {AppException} 工具次数用尽，或结果超限但没有外置存储。
 */
export function createToolGuardMiddleware(): AnyAgentMiddleware {
  return createMiddleware({
    name: 'toolGuard',
    contextSchema: agentRunContextSchema,
    wrapToolCall: async (request, handler) => {
      const scope = executionScope.getStore()
      const budget = readBudget(request.runtime.context)
      budget.assertToolAvailable()
      const callKey = toolCallIdentity(request.toolCall.name, request.toolCall.args)
      budget.consumeToolCall()
      const progress = request.runtime.context.progress
      const toolName = request.toolCall.name
      notifyAgentProgress(progress, {
        kind: 'tool-start',
        at: Date.now(),
        usage: budget.usage,
        lastToolName: toolName,
        noNewInformationStreak: scope?.informationGain?.consecutiveNoGain
      })
      const timeoutMs = scope?.toolTimeoutMs
      const controller = new AbortController()
      const parent = request.runtime.signal
      const onParentAbort = (): void => {
        controller.abort(parent?.reason)
      }
      const timer =
        timeoutMs === undefined
          ? undefined
          : setTimeout(() => controller.abort(new AttemptTimedOut()), timeoutMs)
      if (parent?.aborted) controller.abort(parent.reason)
      else parent?.addEventListener('abort', onParentAbort, { once: true })
      try {
        throwIfStopped(controller.signal)
        const output = await handler(withCallSignal(request, controller.signal))
        if (!ToolMessage.isInstance(output)) {
          recordInformationGain(scope, callKey, output, toolName, request.toolCall.args)
          notifyAgentProgress(progress, {
            kind: 'tool-end',
            at: Date.now(),
            usage: budget.usage,
            lastToolName: toolName,
            noNewInformationStreak: scope?.informationGain?.consecutiveNoGain
          })
          return output
        }
        const externalized = await externalizeToolMessage(
          output,
          request.runtime.context.contentStore,
          scope?.toolResultCharLimit
        )
        recordInformationGain(
          scope,
          callKey,
          externalized.message,
          output.name,
          request.toolCall.args
        )
        notifyAgentProgress(progress, {
          kind: 'tool-end',
          at: Date.now(),
          usage: budget.usage,
          lastToolName: toolName,
          noNewInformationStreak: scope?.informationGain?.consecutiveNoGain
        })
        return externalized.message
      } catch (error) {
        notifyAgentProgress(progress, {
          kind: 'tool-end',
          at: Date.now(),
          usage: budget.usage,
          lastToolName: toolName,
          noNewInformationStreak: scope?.informationGain?.consecutiveNoGain
        })
        if (controller.signal.aborted) throwIfStopped(controller.signal)
        recordConfirmedFailure(budget, error)
        throw error
      } finally {
        clearTimeout(timer)
        parent?.removeEventListener('abort', onParentAbort)
      }
    }
  })
}

/**
 * 同一次失败只在这一处计入错误预算。取消、超时、活跃期限和图步数保护不在这里计数。
 * @param error - 已确认的失败或无进展。
 * @throws {ErrorBudgetExhausted} 错误次数超过上限。原始失败保留在原因里。
 */
export function recordConfirmedFailure(budget: ExecutionBudget, error: unknown): void {
  if (!countsAsErrorAttempt(error)) return
  budget.consumeErrorAttempt(8, error)
}

/** 工具成功后只记录本轮事实。整批在模型调用边界结算，写成功立即清空探索。 */
function recordInformationGain(
  scope: ExecutionScope | undefined,
  callKey: string,
  output: unknown,
  toolName?: string,
  args?: unknown
): void {
  const tracker = scope?.informationGain
  if (!tracker || !scope) return
  const name = toolName ?? readToolName(output)
  const entryPath = scope.context?.workspace?.writablePaths?.[0]
  if ((name === 'writeText' || name === 'replaceText') && !isFailedToolResult(output)) {
    const path = readWritePath(args, output)
    if (entryPath !== undefined && path === entryPath) {
      const signature = writeSignature(name, args, output)
      const changed =
        name === 'replaceText'
          ? replacedCount(output) > 0
          : tracker.lastSignature(path) !== signature
      tracker.onWriteSucceeded(path, signature, changed)
      scope.pendingInformationRound = []
      return
    }
  }
  const signature = resultSignature(output)
  const previous = scope.pendingInformationRound ?? []
  scope.pendingInformationRound = [
    ...previous,
    { key: callKey, signature, repeat: tracker.note(callKey, signature) }
  ]
}

export function settleInformationRound(scope: ExecutionScope | undefined): boolean {
  const tracker = scope?.informationGain
  const facts = scope?.pendingInformationRound
  if (!tracker || !facts || facts.length === 0) return false
  scope.pendingInformationRound = []
  tracker.settleRound(facts)
  return true
}

function readWritePath(args: unknown, output: unknown): string | undefined {
  const fromArgs = readStringField(args, 'path')
  return fromArgs ?? readStringField(output, 'path')
}

function writeSignature(name: string, args: unknown, output: unknown): string {
  if (name === 'replaceText') {
    return JSON.stringify({
      oldText: readStringField(args, 'oldText') ?? '',
      newText: readStringField(args, 'newText') ?? '',
      replaced: replacedCount(output)
    })
  }
  return `${readWritePath(args, output) ?? ''}\n${readStringField(args, 'content') ?? ''}`
}

function replacedCount(output: unknown): number {
  const content = toolContent(output)
  const value = readNumberField(content, 'replaced')
  return value ?? 0
}

function toolContent(output: unknown): unknown {
  if (ToolMessage.isInstance(output)) {
    if (typeof output.content !== 'string') return output.content
    try {
      return JSON.parse(output.content)
    } catch {
      return output.content
    }
  }
  return output
}

function readStringField(value: unknown, key: string): string | undefined {
  if (!value || typeof value !== 'object' || !(key in value)) return undefined
  const field = value[key as keyof typeof value]
  return typeof field === 'string' ? field : undefined
}

function readNumberField(value: unknown, key: string): number | undefined {
  if (!value || typeof value !== 'object' || !(key in value)) return undefined
  const field = value[key as keyof typeof value]
  return typeof field === 'number' ? field : undefined
}

/** @returns 工具名；结果上没有名字时为空。 */
function readToolName(output: unknown): string | undefined {
  if (!output || typeof output !== 'object' || !('name' in output)) return undefined
  return typeof output.name === 'string' ? output.name : undefined
}

/** 工具消息标记失败时，写入不算成功，不能清空无进展记录。 */
function isFailedToolResult(output: unknown): boolean {
  return !!output && typeof output === 'object' && 'status' in output && output.status === 'error'
}

/**
 * 外置结果用内容版本签名，不用随机标识。
 * @returns 可比较的结果签名。
 */
function resultSignature(output: unknown): string {
  const content = ToolMessage.isInstance(output)
    ? output.content
    : output instanceof Error
      ? output.message
      : output
  if (typeof content === 'string') {
    const externalized = externalizedSignature(content)
    return externalized ?? content
  }
  try {
    return JSON.stringify(content) ?? ''
  } catch {
    return ''
  }
}

/** @returns 外置结果的版本签名；不是外置 JSON 时为 undefined。 */
function externalizedSignature(content: string): string | undefined {
  try {
    const value: unknown = JSON.parse(content)
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
    if (!('externalized' in value) || value.externalized !== true || !('version' in value)) {
      return undefined
    }
    const version =
      typeof value.version === 'string' ? value.version : JSON.stringify(value.version)
    const charLength = 'charLength' in value ? JSON.stringify(value.charLength) : ''
    return `${version}:${charLength}`
  } catch {
    return undefined
  }
}

/**
 * 用工具名和参数判断是不是同一次调用。参数顺序不同仍视为同一次。
 * readTextRange 只比较路径和起点，maxChars 只改变本次窗口容量。
 * @returns 稳定的重复键。
 */
function toolCallIdentity(name: string, args: unknown): string {
  if (name === 'readTextRange') {
    const path = readStringField(args, 'path')
    if (path !== undefined) {
      return JSON.stringify({ name, path, start: readNumberField(args, 'start') ?? 0 })
    }
  }
  return JSON.stringify({ name, args: canonicalValue(args) })
}

/** 按字段名排序，避免参数顺序不同被当成新调用。 */
function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => canonicalValue(item))
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, item]) => [key, canonicalValue(item)])
  )
}

export function messageText(message: { content: unknown; tool_calls?: unknown }): string {
  const content =
    typeof message.content === 'string' ? message.content : JSON.stringify(message.content)
  const calls = message.tool_calls === undefined ? '' : JSON.stringify(message.tool_calls)
  return `${content}${calls}`
}

/**
 * 把超长工具结果换成引用。未超限时原样返回。
 * @param store - 本次运行上下文提供的外置存储。
 * @returns 是否截断，以及可以放进消息的工具结果。
 * @throws {AppException} 超过上限但没有外置存储。
 */
async function externalizeToolMessage(
  message: ToolMessage,
  store: ExternalContentStore | undefined,
  limit: number | undefined
): Promise<{ message: ToolMessage; truncated: boolean }> {
  const text =
    typeof message.content === 'string' ? message.content : JSON.stringify(message.content)
  const charLimit = limit ?? Number.POSITIVE_INFINITY
  if ([...text].length <= charLimit) return { message, truncated: false }
  if (!store) {
    throw new AppException({
      code: ErrorCodes.invalidRequest,
      msg: '工具结果超过上限，且本次执行没有外置存储'
    })
  }
  const reference = await store.put(text)
  return {
    truncated: true,
    message: new ToolMessage({
      content: JSON.stringify({
        externalized: true,
        truncated: true,
        complete: false,
        id: reference.id,
        version: reference.version,
        summary: reference.summary,
        charLength: reference.charLength
      }),
      tool_call_id: message.tool_call_id,
      name: message.name,
      status: message.status
    })
  }
}

/**
 * @returns 消息标识；没有标记时为空。
 */
function readRequiredIds(context: unknown): readonly string[] {
  if (!context || typeof context !== 'object' || !('requiredMessageIds' in context)) return []
  return Array.isArray(context.requiredMessageIds) ? context.requiredMessageIds : []
}

/**
 * @param requiredIds - 调用方标记的标识。
 */
function isRequired(
  message: { id?: string; additional_kwargs?: Record<string, unknown> },
  requiredIds: readonly string[]
): boolean {
  if (message.additional_kwargs?.required === true) return true
  return message.id !== undefined && requiredIds.includes(message.id)
}

/**
 * 读取模型响应里的实际 token 用量。结构化结果上的用量只取模型消息那一次。
 * @returns 输入和输出 token；响应没有用量时为 undefined。
 */
export function readTokenUsage(
  response: unknown
): { inputTokens?: number; outputTokens?: number; totalTokens?: number } | undefined {
  const direct = usageFrom(response)
  if (direct) return direct
  if (!response || typeof response !== 'object') return undefined
  const failed = usageFromError(response)
  if (failed) return failed
  if (!('messages' in response) || !Array.isArray(response.messages)) return undefined
  for (const message of response.messages) {
    const usage = usageFrom(message)
    if (usage) return usage
  }
  return undefined
}

/**
 * 当前响应达到长度上限或带有无法执行的工具调用时停止。
 * 只看这一次响应，不记录结束原因。
 * @throws {OutputTruncated} 响应被截断或工具参数无法执行。
 */
function assertCompleteModelResponse(response: unknown): void {
  if (isTruncatedModelResponse(response)) throw new OutputTruncated(response)
}

function isTruncatedModelResponse(response: unknown): boolean {
  if (!response || typeof response !== 'object') return false
  if (hasTruncationSignal(response)) return true
  if ('messages' in response && Array.isArray(response.messages)) {
    const latest = response.messages.at(-1)
    if (latest && typeof latest === 'object' && hasTruncationSignal(latest)) return true
  }
  return false
}

function hasTruncationSignal(value: object): boolean {
  if ('response_metadata' in value && isTruncationMetadata(value.response_metadata)) return true
  if (
    'invalid_tool_calls' in value &&
    Array.isArray(value.invalid_tool_calls) &&
    value.invalid_tool_calls.length > 0
  ) {
    return true
  }
  return 'content' in value && hasInvalidToolCallContent(value.content)
}

function isTruncationMetadata(metadata: unknown): boolean {
  if (!metadata || typeof metadata !== 'object') return false
  return (
    ('finish_reason' in metadata && metadata.finish_reason === 'length') ||
    ('stop_reason' in metadata && metadata.stop_reason === 'max_tokens')
  )
}

function hasInvalidToolCallContent(content: unknown): boolean {
  return (
    Array.isArray(content) &&
    content.some(
      (item) =>
        !!item && typeof item === 'object' && 'type' in item && item.type === 'invalid_tool_call'
    )
  )
}

interface DescribedMessage {
  source: BaseMessage
  content: string
  required: boolean
  toolCallId?: string
  toolCallIds?: string[]
}

/**
 * 让原生工具执行继续注入状态、调用标识和配置，只替换这一次的取消信号。
 * @param signal - 用户取消、活跃时限和工具超时合成的信号。
 */
function withCallSignal<Request extends { tool?: unknown }>(
  request: Request,
  signal: AbortSignal
): Request {
  const tool = request.tool
  if (
    !tool ||
    typeof tool !== 'object' ||
    !('invoke' in tool) ||
    typeof tool.invoke !== 'function'
  ) {
    return request
  }
  const invoke = tool.invoke.bind(tool)
  const guarded = new Proxy(tool, {
    get(target, property, receiver) {
      if (property === 'invoke') {
        return (input: unknown, options?: Record<string, unknown>) =>
          invoke(input, { ...options, signal })
      }
      const value: unknown = Reflect.get(target, property, receiver)
      return typeof value === 'function' ? value.bind(target) : value
    }
  })
  return { ...request, tool: guarded }
}

/**
 * @param requiredIds - 调用方标记的标识。
 */
function describeMessages(
  messages: readonly BaseMessage[],
  requiredIds: readonly string[]
): DescribedMessage[] {
  return messages.map((message) => ({
    source: message,
    content: messageText(message),
    required: isRequired(message, requiredIds),
    toolCallId: ToolMessage.isInstance(message) ? message.tool_call_id : undefined,
    toolCallIds: AIMessage.isInstance(message)
      ? (message.tool_calls ?? []).flatMap((call) => (call.id ? [call.id] : []))
      : undefined
  }))
}

/**
 * @param tools - 本次实际工具定义。省略时用创建时的定义。
 */
function budgetRequest(
  input: ContextGuardInput,
  systemPrompt: string,
  messages: readonly DescribedMessage[],
  tools: readonly unknown[] = input.tools
): Parameters<typeof evaluateContextBudget>[0] {
  return {
    windowTokens: input.contextWindow,
    safetyFraction: input.safetyFraction,
    reservedOutputTokens: input.maxOutputTokens,
    inputBudgetTokens: input.inputBudgetTokens,
    systemPrompt,
    toolDefinitions: tools,
    messages
  }
}

/**
 * 把预算决定转成状态更新。没有裁剪时不改状态。
 * @returns 替换全部消息的更新；无需裁剪时为 undefined。
 */
function trimmedMessages(
  described: readonly DescribedMessage[],
  kept: readonly { content: string }[]
): { messages: BaseMessage[] } | undefined {
  const keptSet = new Set(kept)
  if (keptSet.size === described.length) return undefined
  return {
    messages: [
      new RemoveMessage({ id: REMOVE_ALL_MESSAGES }),
      ...described.filter((item) => keptSet.has(item)).map((item) => item.source)
    ]
  }
}

/**
 * 找到必须留在摘要保留区里的最早消息。
 * @param requiredIds - 调用方标记的标识。
 * @returns 最早的受保护下标；没有必需消息时为 undefined。
 */
function earliestProtectedIndex(
  messages: readonly BaseMessage[],
  requiredIds: readonly string[]
): number | undefined {
  const protectedIndexes = new Set<number>()
  for (let index = 0; index < messages.length; index += 1) {
    if (isRequired(messages[index]!, requiredIds)) protectedIndexes.add(index)
  }
  for (const index of [...protectedIndexes]) {
    const message = messages[index]
    if (ToolMessage.isInstance(message) && message.tool_call_id) {
      for (let earlier = index - 1; earlier >= 0; earlier -= 1) {
        const candidate = messages[earlier]
        if (!AIMessage.isInstance(candidate)) continue
        if ((candidate.tool_calls ?? []).some((call) => call.id === message.tool_call_id)) {
          protectedIndexes.add(earlier)
          break
        }
      }
    }
    if (AIMessage.isInstance(message)) {
      const ids = new Set((message.tool_calls ?? []).flatMap((call) => (call.id ? [call.id] : [])))
      for (let later = index + 1; later < messages.length; later += 1) {
        const candidate = messages[later]
        if (
          ToolMessage.isInstance(candidate) &&
          candidate.tool_call_id !== undefined &&
          ids.has(candidate.tool_call_id)
        ) {
          protectedIndexes.add(later)
        }
      }
    }
  }
  if (protectedIndexes.size === 0) return undefined
  return Math.min(...protectedIndexes)
}

/**
 * 把原生摘要的保留条数写到本次内部上下文，供摘要中间件读取。
 * @param context - 本次执行复制出的运行上下文，不是调用方原对象。
 * @param messagesToKeep - 从最早必需消息算起需要保留的条数。
 */
function rememberKeep(context: unknown, messagesToKeep: number): void {
  if (!context || typeof context !== 'object') return
  ;(context as { keep?: { messages: number } }).keep = { messages: messagesToKeep }
}

/**
 * @returns 必需原文仍在其中的消息列表。
 */
function withRequiredMessages(
  messages: readonly BaseMessage[],
  required: readonly BaseMessage[] | undefined
): BaseMessage[] {
  if (!required || required.length === 0) return [...messages]
  const byId = new Map(
    required.flatMap((message) => (message.id ? [[message.id, message] as const] : []))
  )
  const next = messages.map((message) =>
    message.id !== undefined && byId.has(message.id) ? byId.get(message.id)! : message
  )
  const present = new Set(next.flatMap((message) => (message.id ? [message.id] : [])))
  const missing = required.filter((message) => message.id !== undefined && !present.has(message.id))
  if (missing.length === 0) return next
  if (next.length === 0) return [...missing]
  return [...next.slice(0, -1), ...missing, next[next.length - 1]!]
}

/**
 * 尽量把输出模式变成可估算的文本。循环引用不计入。
 * @returns 模式文本；无法序列化时为空字符串。
 */
function responseFormatText(format: unknown): string {
  if (format === undefined || format === null) return ''
  const seen = new WeakSet<object>()
  try {
    return (
      JSON.stringify(format, (_key, value: unknown) => {
        if (typeof value === 'function') return undefined
        if (typeof value === 'object' && value !== null) {
          if (seen.has(value)) return undefined
          seen.add(value)
        }
        return value
      }) ?? ''
    )
  } catch {
    return ''
  }
}

/** 从单个对象读取 token 用量。没有对应字段时不补 0。 */
function usageFrom(
  value: unknown
): { inputTokens?: number; outputTokens?: number; totalTokens?: number } | undefined {
  if (!value || typeof value !== 'object') return undefined
  const metadata = 'usage_metadata' in value ? value.usage_metadata : undefined
  const fromMetadata = tokenUsage(metadata, 'input_tokens', 'output_tokens', 'total_tokens')
  if (fromMetadata) return fromMetadata
  if (!('response_metadata' in value)) return undefined
  const responseMetadata = value.response_metadata
  if (!responseMetadata || typeof responseMetadata !== 'object' || !('usage' in responseMetadata)) {
    return undefined
  }
  return tokenUsage(responseMetadata.usage, 'prompt_tokens', 'completion_tokens', 'total_tokens')
}

function usageFromError(
  error: object
): { inputTokens?: number; outputTokens?: number; totalTokens?: number } | undefined {
  if ('usage' in error) {
    const usage = tokenUsage(error.usage, 'input_tokens', 'output_tokens', 'total_tokens')
    if (usage) return usage
  }
  if ('cause' in error && error.cause && typeof error.cause === 'object') {
    return usageFrom(error.cause) ?? usageFromError(error.cause)
  }
  return undefined
}
function tokenUsage(
  usage: unknown,
  inputKey: string,
  outputKey: string,
  totalKey: string
): { inputTokens?: number; outputTokens?: number; totalTokens?: number } | undefined {
  if (!usage || typeof usage !== 'object') return undefined
  const record = usage as Record<string, unknown>
  const inputTokens = countOf(record[inputKey])
  const outputTokens = countOf(record[outputKey])
  const totalTokens = countOf(record[totalKey])
  if (inputTokens === undefined && outputTokens === undefined && totalTokens === undefined) {
    return undefined
  }
  return {
    ...(inputTokens === undefined ? {} : { inputTokens }),
    ...(outputTokens === undefined ? {} : { outputTokens }),
    ...(totalTokens === undefined ? {} : { totalTokens })
  }
}

function countOf(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined
}
