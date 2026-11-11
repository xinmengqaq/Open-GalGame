import {
  type AnyAgentMiddleware,
  createMiddleware,
  ProviderStrategy,
  ToolStrategy
} from 'langchain'

import { agentRunContextSchema } from '../agents/AgentRunContextSchema'
import { FinalizeRequested } from '../execution/executionErrors'
import { executionScope } from '../execution/executionScope'
import { notifyAgentProgress } from '../execution/AgentProgress'
import { readBudget, settleInformationRound } from './executionMiddleware'

const NUDGE =
  '[执行约束] 你已经多次读到相同内容。信息足够时写出候选并提交：有 submit_scene_result 工具时调用该工具，否则直接输出最终 JSON；需要用户决定时返回 action=request_clarification；无法继续时返回 action=report_blocked。不要重复读取未变化内容。'
const POST_WRITE_NUDGE =
  '[执行约束] 候选已经写出。下一步只能提交或报告阻塞；不要重复读取未变化内容，也不要无限改写。'
const structuredValidators = new WeakMap<object, (value: Record<string, unknown>) => boolean>()

/**
 * 探索重复到阈值时提醒继续；候选写出后最多自动自检 2 轮。
 * 提示不写入图状态，只附加在这一次模型请求上。
 * @throws {FinalizeRequested} 重复读取到阈值，或写后第 3 轮仍无合法结构化提交。
 */
export function createInformationGainMiddleware(): AnyAgentMiddleware {
  return createMiddleware({
    name: 'informationGain',
    contextSchema: agentRunContextSchema,
    wrapModelCall: async (request, handler) => {
      const scope = executionScope.getStore()
      const tracker = scope?.informationGain
      const settled = settleInformationRound(scope)
      const postWriteNudged = tracker?.takePostWriteNudge() === true
      const nudged = !postWriteNudged && tracker?.needsNudge() === true && tracker.takeNudge()
      if (nudged || postWriteNudged) {
        const budget = readBudget(request.runtime.context)
        notifyAgentProgress(request.runtime.context.progress, {
          kind: 'completion-nudge',
          at: Date.now(),
          usage: budget.usage,
          noNewInformationStreak: tracker?.consecutiveNoGain
        })
      }
      const notice = postWriteNudged ? POST_WRITE_NUDGE : nudged ? NUDGE : undefined
      if (settled && tracker?.shouldStop())
        throw new FinalizeRequested('noNewInformation')
      const response = await handler(notice ? withExecutionNotice(request, notice) : request)
      if (!tracker) return response
      const submitted = hasStructuredSubmission(response, request.responseFormat)
      tracker.afterModelResponse(submitted)
      if (tracker.shouldStopAfterPostWrite())
        throw new FinalizeRequested('postWriteNoSubmission')
      return response
    }
  })
}

/** 从本次请求的 responseFormat 取结构化工具名。原生格式没有工具名。 */
export function structuredToolNames(format: unknown): ReadonlySet<string> {
  const names = new Set<string>()
  collectStructuredNames(format, names)
  return names
}

function collectStructuredNames(format: unknown, names: Set<string>): void {
  if (!format || typeof format !== 'object') return
  if (Array.isArray(format)) {
    for (const item of format) collectStructuredNames(item, names)
    return
  }
  if (format instanceof ToolStrategy && format.name.length > 0) names.add(format.name)
}

/**
 * 本轮是否已经形成可结算的结构化结果。
 * 工具通道必须参数可解析且通过 schema；字段非法或无法解析只凭工具名不算提交。
 * 原生通道没有结构化工具：正常结束且没有工具调用的终态响应就是提交候选，
 * 不能因库尚未回填 structuredResponse（外层通道在中间件之后才转换）而计为未提交。
 */
export function hasStructuredSubmission(response: unknown, format: unknown): boolean {
  if (hasSettledStructuredResponse(response, format)) return true
  const names = structuredToolNames(format)
  const calls = [...readCalls(response, 'tool_calls'), ...readCalls(response, 'invalid_tool_calls')]
  if (calls.some((call) => isValidStructuredCall(call, format, names))) return true
  return names.size === 0 && isTerminalNativeResponse(response)
}

function isTerminalNativeResponse(response: unknown): boolean {
  if (!response || typeof response !== 'object') return false
  if (readCalls(response, 'tool_calls').length > 0) return false
  if (readCalls(response, 'invalid_tool_calls').length > 0) return false
  const metadata = 'response_metadata' in response ? response.response_metadata : undefined
  if (!metadata || typeof metadata !== 'object') return true
  const finishReason = 'finish_reason' in metadata ? metadata.finish_reason : undefined
  return (
    finishReason === undefined ||
    finishReason === null ||
    finishReason === 'stop' ||
    finishReason === 'end_turn'
  )
}

function hasSettledStructuredResponse(response: unknown, format: unknown): boolean {
  if (!usesProviderStrategy(format)) return false
  if (!response || typeof response !== 'object' || !('structuredResponse' in response)) return false
  const settled = response.structuredResponse
  return !!settled && typeof settled === 'object'
}

function usesProviderStrategy(format: unknown): boolean {
  if (!format || typeof format !== 'object') return false
  if (Array.isArray(format)) return format.some((item) => usesProviderStrategy(item))
  return format instanceof ProviderStrategy
}

function readCalls(response: unknown, key: 'tool_calls' | 'invalid_tool_calls'): unknown[] {
  if (!response || typeof response !== 'object' || !(key in response)) return []
  const value = response[key]
  return Array.isArray(value) ? value : []
}

function isValidStructuredCall(
  call: unknown,
  format: unknown,
  structuredNames: ReadonlySet<string>
): boolean {
  if (!call || typeof call !== 'object' || !('name' in call) || typeof call.name !== 'string') {
    return false
  }
  if (!structuredNames.has(call.name) || ('error' in call && call.error)) return false
  if (!('args' in call)) return false
  const args = parsedArgs(call.args)
  if (!args) return false
  const validate = validatorFor(format, call.name)
  return validate ? validate(args) : true
}

function parsedArgs(value: unknown): Record<string, unknown> | undefined {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return Object.fromEntries(Object.entries(value))
  }
  if (typeof value !== 'string' || value.length === 0) return undefined
  try {
    const parsed: unknown = JSON.parse(value)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
    return Object.fromEntries(Object.entries(parsed))
  } catch {
    return undefined
  }
}

function validatorFor(
  format: unknown,
  name: string
): ((value: Record<string, unknown>) => boolean) | undefined {
  if (!format || typeof format !== 'object') return undefined
  if (Array.isArray(format)) {
    for (const item of format) {
      const found = validatorFor(item, name)
      if (found) return found
    }
    return undefined
  }
  if (!(format instanceof ToolStrategy) || format.name !== name) return undefined
  const cached = structuredValidators.get(format)
  if (cached) return cached
  const validate = (value: Record<string, unknown>): boolean => {
    try {
      format.parse(value)
      return true
    } catch {
      return false
    }
  }
  structuredValidators.set(format, validate)
  return validate
}

function withExecutionNotice<
  Message extends { concat(text: string): Message },
  Request extends { systemMessage?: Message; systemPrompt?: string }
>(request: Request, notice: string): Request {
  const message = request.systemMessage
  if (message) return { ...request, systemMessage: message.concat(`\n\n${notice}`) }
  return { ...request, systemPrompt: `${request.systemPrompt ?? ''}\n\n${notice}` }
}
