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

export function estimateTokens(text: string): number {
  let ascii = 0
  let tokens = 0
  for (const char of text) {
    if (char.charCodeAt(0) <= 0x7f) ascii += 1
    else tokens += 2
  }
  return tokens + Math.ceil(ascii / 3)
}

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

function singleUnit(message: ContextBudgetMessage): MessageUnit {
  return {
    messages: [message],
    tokens: estimateTokens(message.content),
    required: message.required === true || message.toolCallId !== undefined
  }
}

function overflow(msg: string): AppException {
  return new AppException({ code: ErrorCodes.invalidRequest, msg, diagnosticCategory: 'context' })
}
