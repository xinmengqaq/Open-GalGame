import { AIMessage, ToolMessage, type BaseMessage } from '@langchain/core/messages'
import { Command } from '@langchain/langgraph'
import { createMiddleware, toolStrategy, type AnyAgentMiddleware, type ModelRequest } from 'langchain'

import { AppException } from '@common/errors/AppException'
import { ErrorCodes } from '@common/errors/ErrorCodes'
import type { AgentExecutionMode } from '@infrastructure/ai/agents/AgentExecution'
import { SCENE_RESULT_TOOL_NAME, sceneAgentOutputSchema } from './WebGalSceneAgentTypes'

const NO_RESPONSE_FORMAT = { __responseFormatUndefined: true } as const
const JSON_OBJECT = { type: 'json_object' } as const

const MAX_ISSUES = 3
const MAX_ISSUE_LENGTH = 120
type StructuredMode = 'json_schema' | 'json_object' | 'tool'
const capabilities = new Map<string, StructuredMode>()
/** 本次执行实际使用的结构化通道；工具通道才有提交工具，收尾限制只在此时生效。 */
const channelModes = new WeakMap<object, StructuredMode>()

/** 读取本次执行的结构化通道；未知时返回 undefined，调用方不应假定存在提交工具。 */
export function structuredChannelMode(context: unknown): StructuredMode | undefined {
  return context && typeof context === 'object' ? channelModes.get(context) : undefined
}

type ChannelRequest = ModelRequest<
  Record<string, unknown>,
  { executionMode?: AgentExecutionMode }
>

/**
 * 同一次装配内按真实响应选择结构化通道。
 * 先发 json_schema；该格式被拒且 json_object 可用时改真实请求并本地校验；两者都不可用才回退固定工具。
 */
export function createSceneStructuredChannel(): AnyAgentMiddleware {
  return createMiddleware({
    name: 'sceneStructuredChannel',
    wrapModelCall: async (request, handler) => {
      const identity = modelIdentity(request.model)
      const mode = capabilities.get(identity) ?? 'json_schema'
      try {
        const response = await handler(withoutBudgetSchema(prepareRequest(request, mode)))
        if (mode !== 'tool' && isTerminalMessage(response)) return structuredState(response)
        return response
      } catch (error) {
        const rejected = rejectedFormat(error)
        if (!rejected || mode === 'tool') throw error
        const next: StructuredMode =
          mode === 'json_schema' && rejected === 'json_schema' ? 'json_object' : 'tool'
        capabilities.set(identity, next)
        try {
          const response = await handler(withoutBudgetSchema(prepareRequest(request, next)))
          return next !== 'tool' && isTerminalMessage(response)
            ? structuredState(response)
            : response
        } catch (nextError) {
          if (next !== 'json_object' || rejectedFormat(nextError) !== 'json_object') throw nextError
          capabilities.set(identity, 'tool')
          return handler(withoutBudgetSchema(prepareRequest(request, 'tool')))
        }
      }
    }
  })
}

function withoutBudgetSchema<T extends ChannelRequest>(request: T): T {
  return {
    ...request,
    ...(request.systemPrompt ? { systemPrompt: stripSchema(request.systemPrompt) } : {}),
    ...(request.systemMessage && typeof request.systemMessage.content === 'string'
      ? {
          systemMessage: {
            ...request.systemMessage,
            content: stripSchema(request.systemMessage.content)
          }
        }
      : {})
  }
}

function stripSchema(prompt: string): string {
  const index = prompt.indexOf('{"$schema":')
  return index < 0 ? prompt : prompt.slice(0, index).trimEnd()
}


function prepareRequest(request: ChannelRequest, mode: StructuredMode): ChannelRequest {
  if (request.runtime?.context && typeof request.runtime.context === 'object')
    channelModes.set(request.runtime.context, mode)
  if (mode === 'json_object') {
    return {
      ...request,
      responseFormat: NO_RESPONSE_FORMAT,
      model: bindJsonObject(request.model),
      toolChoice: undefined
    }
  }
  if (mode !== 'tool') return request
  const written = request.messages.some((message) => hasWriteCall(message))
  const finalize = request.runtime.context.executionMode === 'finalize'
  return {
    ...request,
    responseFormat: toolStrategy(sceneAgentOutputSchema, {
      handleError: (error) => boundedStructuredCorrection(error)
    }),
    ...(written || finalize
      ? { toolChoice: { type: 'function', function: { name: SCENE_RESULT_TOOL_NAME } } }
      : {})
  }
}

function bindJsonObject(model: ChannelRequest['model']): ChannelRequest['model'] {
  if (!model || typeof model !== 'object' || !('withConfig' in model) || typeof model.withConfig !== 'function') {
    return model
  }
  return model.withConfig({ response_format: JSON_OBJECT }) as ChannelRequest['model']
}

function modelIdentity(model: unknown): string {
  const fields = model && typeof model === 'object' ? (model as Record<string, unknown>) : {}
  const client =
    fields.client && typeof fields.client === 'object'
      ? (fields.client as Record<string, unknown>)
      : {}
  return [
    text(fields.model) || text(fields.modelName) || 'unknown',
    text(client.baseURL) || text(fields.baseURL) || text(fields.anthropicApiUrl)
  ].join('\n')
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function rejectedFormat(error: unknown): 'json_schema' | 'json_object' | undefined {
  const seen = new Set<unknown>()
  let current: unknown = error
  while (current && typeof current === 'object' && !seen.has(current)) {
    seen.add(current)
    const message = current instanceof Error ? current.message : ''
    if (/json_object|json mode/i.test(message)) return 'json_object'
    if (/response_format|json_schema/i.test(message)) return 'json_schema'
    current = 'cause' in current ? current.cause : undefined
  }
  return undefined
}

function hasWriteCall(message: BaseMessage): boolean {
  return (
    'tool_calls' in message &&
    Array.isArray(message.tool_calls) &&
    message.tool_calls.some((call) => call.name === 'writeText' || call.name === 'replaceText')
  )
}

function isTerminalMessage(response: unknown): response is AIMessage {
  return AIMessage.isInstance(response) && (!response.tool_calls || response.tool_calls.length === 0)
}
function structuredState(response: AIMessage): Command {
  const parsed = sceneAgentOutputSchema.safeParse(parseJsonContent(response.content))
  if (!parsed.success) throw invalidStructuredOutput(safeIssues(parsed.error.issues))
  return new Command({
    update: { structuredResponse: parsed.data, messages: [response] }
  })
}

function parseJsonContent(content: AIMessage['content']): unknown {
  const textContent =
    typeof content === 'string'
      ? content
      : content.find(
          (block): block is { type: 'text'; text: string } =>
            !!block &&
            typeof block === 'object' &&
            'type' in block &&
            block.type === 'text' &&
            'text' in block &&
            typeof block.text === 'string'
        )?.text
  if (!textContent) return undefined
  try {
    return JSON.parse(textContent)
  } catch {
    return undefined
  }
}

/**
 * 工具参数被库丢弃字段路径时，用原始参数重新做本地校验。
 * 只返回路径和错误码，不回显参数值或模型原文。
 */
export function boundedStructuredCorrection(error: unknown): string {
  const parsed = sceneAgentOutputSchema.safeParse(toolArguments(error))
  const issues = parsed.success ? [] : safeIssues(parsed.error.issues)
  return correctionText(issues)
}

function toolArguments(error: unknown): unknown {
  if (!error || typeof error !== 'object') return undefined
  if ('toolCall' in error && error.toolCall && typeof error.toolCall === 'object') {
    const call = error.toolCall as Record<string, unknown>
    if ('args' in call) return call.args
  }
  if (!('lc_kwargs' in error)) return undefined
  const kwargs = error.lc_kwargs
  if (!kwargs || typeof kwargs !== 'object' || !('messages' in kwargs)) return undefined
  const messages = kwargs.messages
  if (!Array.isArray(messages)) return undefined
  const toolMessage = [...messages].reverse().find((message) => ToolMessage.isInstance(message))
  if (!ToolMessage.isInstance(toolMessage)) return undefined
  const content = typeof toolMessage.content === 'string' ? toolMessage.content : ''
  const match = content.match(/arguments:\s*(\{[\s\S]*\})/)
  if (!match?.[1]) return undefined
  try {
    return JSON.parse(match[1])
  } catch {
    return undefined
  }
}

function safeIssues(
  issues: readonly { path: PropertyKey[]; code: string }[]
): { path: string; code: string }[] {
  return issues.slice(0, MAX_ISSUES).map((issue) => ({
    path: issue.path.map(String).join('.').slice(0, MAX_ISSUE_LENGTH),
    code: issue.code.slice(0, MAX_ISSUE_LENGTH)
  }))
}

function correctionText(issues: readonly { path: string; code: string }[]): string {
  const listed = issues.map((issue) => `${issue.path || '(root)'} ${issue.code}`).join('；')
  return `完成结果不符合约定，请重新提交完整字段。${listed ? `问题：${listed}。` : ''}`
}

function invalidStructuredOutput(issues: readonly { path: string; code: string }[]): AppException {
  return new AppException({
    code: ErrorCodes.invalidRequest,
    msg: '模型输出不符合约定',
    cause: { issues },
    diagnosticCategory: 'structured-output'
  })
}

