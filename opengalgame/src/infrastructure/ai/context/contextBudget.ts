import { AppException } from '@common/errors/AppException'
import { ErrorCodes } from '@common/errors/ErrorCodes'

export interface ContextBudgetMessage {
  content: string
  required?: boolean
  toolCallId?: string
  toolCallIds?: readonly string[]
}

export interface ContextBudgetRequest {
  windowTokens: number
  safetyFraction: number
  reservedOutputTokens: number
  inputBudgetTokens?: number
  systemPrompt: string
  toolDefinitions: readonly unknown[]
  messages: readonly ContextBudgetMessage[]
}

export interface ContextBudgetDecision {
  allowedTokens: number
  estimatedTokens: number
  messages: ContextBudgetMessage[]
}

/**
 * 保守估算文本占用的 token。
 * 非 ASCII 码位按 2 个 token 计算，ASCII 每 3 个字符计算 1 个 token。
 * @returns 不小于实际常见分词结果的估算值。空文本为 0。
 */
export function estimateTokens(text: string): number {
  let ascii = 0
  let tokens = 0
  for (const char of text) {
    if (char.charCodeAt(0) <= 0x7f) ascii += 1
    else tokens += 2
  }
  return tokens + Math.ceil(ascii / 3)
}

/**
 * 计算扣除输出预留、安全余量和调用方输入预算后的可用输入空间。
 * 较小的模型窗口不会被固定的 24000 token 预算撑大。
 * @returns 可用输入 token。窗口本身非法时为负数或 0，由核对函数拒绝。
 */
export function allowedInputTokens(
  request: Pick<
    ContextBudgetRequest,
    'windowTokens' | 'safetyFraction' | 'reservedOutputTokens' | 'inputBudgetTokens'
  >
): number {
  const safetyTokens = Math.ceil(request.windowTokens * request.safetyFraction)
  const room = request.windowTokens - request.reservedOutputTokens - safetyTokens
  if (request.inputBudgetTokens === undefined) return room
  return Math.min(room, request.inputBudgetTokens)
}

/**
 * 核对系统提示、工具定义、消息、输出预留和安全余量。
 * 必需内容超出可用空间时失败；裁剪时工具调用与结果一起保留或一起移除。
 * @returns 实际允许的输入 token、估算用量和保留的消息。
 * @throws {AppException} 窗口或预算无法容纳必需内容。
 */
export function evaluateContextBudget(request: ContextBudgetRequest): ContextBudgetDecision {
  if (!Number.isSafeInteger(request.windowTokens) || request.windowTokens <= 0) {
    throw overflow('上下文窗口必须为正整数')
  }
  const allowedTokens = allowedInputTokens(request)
  if (!Number.isFinite(allowedTokens) || allowedTokens <= 0) {
    throw overflow('上下文窗口扣除输出预留和安全余量后没有可用输入空间')
  }

  const fixedTokens =
    estimateTokens(request.systemPrompt) + estimateTokens(JSON.stringify(request.toolDefinitions))
  const units = groupMessages(request.messages)
  const requiredTokens = units
    .filter((unit) => unit.required)
    .reduce((sum, unit) => sum + unit.tokens, 0)
  if (fixedTokens + requiredTokens > allowedTokens) {
    throw overflow('必需内容超过上下文预算')
  }

  let estimatedTokens = fixedTokens + units.reduce((sum, unit) => sum + unit.tokens, 0)
  const dropped = new Set<ContextBudgetMessage>()
  for (const unit of units) {
    if (estimatedTokens <= allowedTokens) break
    if (unit.required) continue
    estimatedTokens -= unit.tokens
    for (const message of unit.messages) dropped.add(message)
  }
  const messages = request.messages.filter((message) => !dropped.has(message))
  if (request.messages.length > 0 && messages.length === 0) {
    throw overflow('本次输入超过上下文预算')
  }
  return { allowedTokens, estimatedTokens, messages }
}

interface MessageUnit {
  messages: ContextBudgetMessage[]
  tokens: number
  required: boolean
}

/** 把工具调用和对应结果收成不可拆开的一组。 */
function groupMessages(messages: readonly ContextBudgetMessage[]): MessageUnit[] {
  const claimed = new Set<number>()
  const units: MessageUnit[] = []
  for (let index = 0; index < messages.length; index += 1) {
    if (claimed.has(index)) continue
    const message = messages[index]!
    const callIds = message.toolCallIds ?? []
    if (callIds.length === 0) {
      units.push(singleUnit(message))
      continue
    }
    const ids = new Set(callIds)
    const grouped = [message]
    for (let follower = index + 1; follower < messages.length; follower += 1) {
      const candidate = messages[follower]!
      if (candidate.toolCallId !== undefined && ids.has(candidate.toolCallId)) {
        grouped.push(candidate)
        claimed.add(follower)
      }
    }
    const unpaired = callIds.some((id) => !grouped.some((item) => item.toolCallId === id))
    units.push({
      messages: grouped,
      tokens: grouped.reduce((sum, item) => sum + estimateTokens(item.content), 0),
      required: unpaired || grouped.some((item) => item.required === true)
    })
  }
  return units
}

/**
 * @param message - 不携带工具调用的消息。
 * @returns 只含这一条消息的组。
 */
function singleUnit(message: ContextBudgetMessage): MessageUnit {
  return {
    messages: [message],
    tokens: estimateTokens(message.content),
    required: message.required === true || message.toolCallId !== undefined
  }
}

/**
 * @returns 请求无法继续的异常。
 */
function overflow(msg: string): AppException {
  return new AppException({ code: ErrorCodes.invalidRequest, msg, diagnosticCategory: 'context' })
}
