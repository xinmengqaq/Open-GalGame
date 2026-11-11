import pino, { type DestinationStream } from 'pino'
import type { AgentStreamSubscriber } from './AgentStreamEvent'

export type ConsoleAgentStreamLoggerOptions = {
  enabled: boolean
  destination?: DestinationStream
}

/** 创建显式启用的 Pino 控制台订阅；正文、原始异常及 Token 增量均不写入。 */
export function createConsoleAgentStreamLogger(
  options: ConsoleAgentStreamLoggerOptions
): AgentStreamSubscriber {
  if (!options.enabled) return () => {}
  const logger = pino({ base: null }, options.destination ?? process.stdout)
  return (event) => {
    if (event.type === 'text') return
    const fields: Record<string, unknown> = {
      executionId: safeLabel(event.executionId),
      agentId: safeLabel(event.agentId),
      runId: safeLabel(event.runId),
      eventType: event.type,
      sequence: event.sequence,
      status: event.status
    }
    if (event.parentRunId) fields.parentRunId = safeLabel(event.parentRunId)
    if (event.toolCallId) fields.toolCallId = safeLabel(event.toolCallId)
    if ('durationMs' in event) fields.durationMs = event.durationMs
    if (event.type === 'model') {
      fields.modelName = event.modelName === undefined ? undefined : safeModelName(event.modelName)
      if (event.usage)
        fields.usage = {
          inputTokens: event.usage.inputTokens,
          outputTokens: event.usage.outputTokens,
          totalTokens: event.usage.totalTokens
        }
    }
    if (event.type === 'tool' && event.toolName) fields.toolName = safeLabel(event.toolName)
    const messages = {
      run: 'Agent 运行状态',
      model: '模型调用状态',
      tool: '工具调用状态',
      state: '执行技术状态'
    }
    logger.info(fields, messages[event.type])
  }
}

/** 模型字段允许供应商限定名称，排除绝对路径、控制字符及密钥形式。 */
function safeModelName(value: string): string {
  return value.length <= 128 &&
    /^[\p{L}\p{N}_.:/-]+$/u.test(value) &&
    !/^(?:[A-Za-z]:|\/)|\\|(?:^|\/)(?:sk-|key-|Bearer)/i.test(value)
    ? value
    : '[已隐藏]'
}

/** 只允许短标识，拒绝控制字符、路径和常见密钥形式。 */
function safeLabel(value: string): string {
  return value.length <= 128 &&
    /^[\p{L}\p{N}_.:-]+$/u.test(value) &&
    !/[\\/]|^[A-Za-z]:|(?:sk-|key-|Bearer)/i.test(value)
    ? value
    : '[已隐藏]'
}
