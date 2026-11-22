import type { AgentEvent, AgentMessage } from '@earendil-works/pi-agent-core'
import type { AssistantMessage } from '@earendil-works/pi-ai'

import { notifyAgentProgress, type AgentProgressObserver } from '../execution/AgentProgress'
import type { ExecutionBudget, ExecutionBudgetUsage } from '../execution/ExecutionBudget'
import type {
  AgentRunStatus,
  AgentStreamError,
  AgentStreamEvent,
  AgentStreamObservation,
  AgentTokenUsage
} from '../streaming/AgentStreamEvent'
import {
  createAgentStreamConsumer,
  type AgentStreamDiagnostic
} from '../streaming/AgentStreamConsumer'

/** 一次 Pi 运行的结束状态。 */
export type PiRunStatus = Extract<AgentRunStatus, 'succeeded' | 'failed' | 'cancelled'>

export interface PiEventStreamOptions {
  executionId: string
  agentId: string
  runId: string
  modelName: string
  observation?: AgentStreamObservation
  progress?: AgentProgressObserver
  budget?: ExecutionBudget
  now?: () => number
  diagnostic?: AgentStreamDiagnostic
}

const emptyUsage: ExecutionBudgetUsage = {
  modelAttempts: 0,
  toolCalls: 0,
  activeMs: 0,
  tokens: 0
}

/**
 * 把 Pi 的 AgentEvent 映射为现有 AgentStreamEvent 和 AgentProgressEvent。
 *
 * 只观察，不结算操作。观察回调抛错只影响订阅本身；不会改写 Pi 的运行状态。
 * `agent_end` 不在这里产生 run 终态，由执行入口在读取完 transcript 后调用 `finish`。
 */
export class PiEventStream {
  private readonly consumer
  private readonly executionId: string
  private readonly agentId: string
  private readonly runId: string
  private readonly modelName: string
  private readonly progress: AgentProgressObserver | undefined
  private readonly budget: ExecutionBudget | undefined
  private readonly now: () => number
  private readonly textDeltas: boolean
  private sequence = 0
  private startedAt: number
  private started = false
  private ended = false
  private modelStartedAt: number | undefined
  private readonly toolStartedAt = new Map<string, number>()
  private lastToolName: string | undefined

  constructor(options: PiEventStreamOptions) {
    this.executionId = options.executionId
    this.agentId = options.agentId
    this.runId = options.runId
    this.modelName = options.modelName
    this.progress = options.progress
    this.budget = options.budget
    this.now = options.now ?? Date.now
    this.textDeltas = options.observation?.textDeltas === true
    this.startedAt = this.now()
    this.consumer = createAgentStreamConsumer(options.diagnostic)
    for (const subscription of options.observation?.subscriptions ?? []) {
      this.consumer.subscribe(subscription.onEvent, subscription.signal)
    }
  }

  /** 发出 run started；重复调用无副作用。 */
  start(): void {
    if (this.started || this.ended) return
    this.started = true
    this.startedAt = this.now()
    this.dispatch({ type: 'run', status: 'started' })
  }

  /**
   * 处理一个 Pi 事件。任何异常都留在观察边界，不影响生成。
   * @param event - Pi 的 AgentEvent。
   * @param signal - 当前运行的取消信号。
   */
  handle(event: AgentEvent, signal?: AbortSignal): void {
    try {
      if (this.ended) return
      if (!this.started) this.start()
      switch (event.type) {
        case 'message_start':
          this.handleMessageStart(event.message)
          return
        case 'message_update':
          this.handleMessageUpdate(event)
          return
        case 'message_end':
          this.handleMessageEnd(event.message, signal)
          return
        case 'tool_execution_start':
          this.handleToolStart(event)
          return
        case 'tool_execution_end':
          this.handleToolEnd(event, signal)
          return
        default:
          return
      }
    } catch {
      // 观察失败不构成生成失败。
    }
  }

  /**
   * 发出唯一的 run 终态并解除订阅。
   * @param status - 成功、失败或取消。
   * @param errorMessage - 不含密钥的可展示说明。
   */
  finish(status: PiRunStatus, errorMessage?: string): void {
    if (this.ended) return
    if (!this.started) this.start()
    this.ended = true
    const durationMs = Math.max(0, this.now() - this.startedAt)
    this.dispatch({
      type: 'run',
      status,
      durationMs,
      ...(status === 'failed' && errorMessage !== undefined
        ? { error: { category: 'execution', message: errorMessage } }
        : {})
    })
    this.consumer.release()
  }

  private handleMessageStart(message: AgentMessage): void {
    if (!isAssistant(message)) return
    this.modelStartedAt = this.now()
    this.lastToolName = undefined
    this.dispatch({
      type: 'model',
      status: 'started',
      modelName: this.modelName,
      ...(message.responseId ? { messageId: message.responseId } : {})
    })
    this.progressEvent('model-start')
  }

  private handleMessageUpdate(event: Extract<AgentEvent, { type: 'message_update' }>): void {
    if (!this.textDeltas || !isAssistant(event.message)) return
    const update = event.assistantMessageEvent
    if (update.type !== 'text_delta' || update.delta.length === 0) return
    this.dispatch({
      type: 'text',
      text: update.delta,
      ...(event.message.responseId ? { messageId: event.message.responseId } : {})
    })
  }

  private handleMessageEnd(message: AgentMessage, signal: AbortSignal | undefined): void {
    if (!isAssistant(message)) return
    const cancelled =
      message.stopReason === 'aborted' ||
      (signal?.aborted === true && message.stopReason !== 'error')
    const failed = message.stopReason === 'error'
    const durationMs =
      message.durationMs ??
      (this.modelStartedAt === undefined ? undefined : this.now() - this.modelStartedAt)
    this.dispatch({
      type: 'model',
      status: cancelled || failed ? 'failed' : 'succeeded',
      modelName: this.modelName,
      ...(durationMs !== undefined ? { durationMs: Math.max(0, durationMs) } : {}),
      usage: tokenUsage(message),
      ...(cancelled
        ? { error: { category: 'model', message: '模型请求已取消' } satisfies AgentStreamError }
        : failed
          ? { error: { category: 'model', message: '模型请求失败' } satisfies AgentStreamError }
          : {}),
      ...(message.responseId ? { messageId: message.responseId } : {})
    })
    this.modelStartedAt = undefined
    this.progressEvent('model-end')
  }

  private handleToolStart(event: Extract<AgentEvent, { type: 'tool_execution_start' }>): void {
    this.toolStartedAt.set(event.toolCallId, this.now())
    this.lastToolName = event.toolName
    this.dispatch({
      type: 'tool',
      status: 'started',
      toolName: event.toolName,
      toolCallId: event.toolCallId
    })
    this.progressEvent('tool-start')
  }

  private handleToolEnd(
    event: Extract<AgentEvent, { type: 'tool_execution_end' }>,
    signal: AbortSignal | undefined
  ): void {
    const startedAt = this.toolStartedAt.get(event.toolCallId)
    this.toolStartedAt.delete(event.toolCallId)
    this.lastToolName = event.toolName
    const interrupted = signal?.aborted === true
    const status = interrupted ? 'interrupted' : event.isError ? 'failed' : 'succeeded'
    const durationMs =
      event.durationMs ?? (startedAt === undefined ? undefined : this.now() - startedAt)
    const errorText = event.isError ? resultErrorText(event.result) : undefined
    this.dispatch({
      type: 'tool',
      status,
      toolName: event.toolName,
      toolCallId: event.toolCallId,
      ...(durationMs !== undefined ? { durationMs: Math.max(0, durationMs) } : {}),
      ...(status === 'failed' || status === 'interrupted'
        ? {
            error: {
              category: 'tool',
              message: status === 'interrupted' ? '工具执行已中断' : (errorText ?? '工具执行失败')
            } satisfies AgentStreamError
          }
        : {})
    })
    this.progressEvent('tool-end')
    this.lastToolName = undefined
  }

  /** 分发一个带本次运行身份和递增序号的事件。 */
  private dispatch(event: DistributionEvent): void {
    this.consumer.dispatch({
      executionId: this.executionId,
      agentId: this.agentId,
      runId: this.runId,
      sequence: ++this.sequence,
      timestamp: this.now(),
      ...event
    } as AgentStreamEvent)
  }

  /** 进度观察失败只留在回调边界。 */
  private progressEvent(kind: 'model-start' | 'model-end' | 'tool-start' | 'tool-end'): void {
    notifyAgentProgress(this.progress, {
      kind,
      at: this.now(),
      usage: this.budget?.usage ?? { ...emptyUsage },
      ...(this.lastToolName !== undefined ? { lastToolName: this.lastToolName } : {})
    })
  }
}

type DistributionEvent =
  | { type: 'run'; status: AgentRunStatus; durationMs?: number; error?: AgentStreamError }
  | {
      type: 'model'
      status: 'started' | 'succeeded' | 'failed'
      modelName?: string
      durationMs?: number
      usage?: AgentTokenUsage
      error?: AgentStreamError
      messageId?: string
    }
  | {
      type: 'tool'
      status: 'started' | 'progress' | 'succeeded' | 'failed' | 'interrupted'
      toolName?: string
      durationMs?: number
      error?: AgentStreamError
      toolCallId?: string
    }
  | { type: 'text'; text: string; messageId?: string }

/** Pi 的 AgentMessage 与 AssistantMessage 只是角色收窄。 */
function isAssistant(message: AgentMessage): message is AssistantMessage {
  return message.role === 'assistant'
}

/** @returns 与现有 AgentStreamEvent 相同的 token 视图。 */
function tokenUsage(message: AssistantMessage): AgentTokenUsage {
  return {
    inputTokens: message.usage.input,
    outputTokens: message.usage.output,
    totalTokens: message.usage.totalTokens
  }
}

/** 从工具结果里取第一条文本诊断；截断，避免把长内容复制到事件。 */
function resultErrorText(result: unknown): string | undefined {
  if (result === null || typeof result !== 'object' || !('content' in result)) return undefined
  const content = result.content
  if (!Array.isArray(content)) return undefined
  for (const block of content) {
    if (block === null || typeof block !== 'object') continue
    if (!('type' in block) || block.type !== 'text') continue
    if (!('text' in block) || typeof block.text !== 'string') continue
    const text = block.text.trim()
    if (text.length > 0) return text.length > 200 ? `${text.slice(0, 200)}…` : text
  }
  return undefined
}
