import { RemoveMessage } from '@langchain/core/messages'
import { REMOVE_ALL_MESSAGES } from '@langchain/langgraph'
import {
  ClearToolUsesEdit,
  type AnyAgentMiddleware,
  contextEditingMiddleware,
  createMiddleware,
  summarizationMiddleware
} from 'langchain'

import { AppException } from '@common/errors/AppException'
import { ErrorCodes } from '@common/errors/ErrorCodes'
import { agentRunContextSchema } from '../agents/AgentRunContextSchema'
import type { AgentExecutionProfile } from '../config/agentExecutionConfig'
import { allowedInputTokens, estimateTokens } from '../context/contextBudget'
import { ActiveLimitExceeded, AttemptTimedOut, waitWithSignal } from '../execution/executionErrors'
import { notifyAgentProgress } from '../execution/AgentProgress'
import { executionScope } from '../execution/executionScope'
import type { ChatModelCreation } from '../models/LangChainModelFactory'
import {
  createAttemptMeterMiddleware,
  createBudgetGateMiddleware,
  createContextGuardMiddleware,
  createFinalRequestGuard,
  createModelTimeoutMiddleware,
  createRequiredContentMiddleware,
  createToolChoiceRelaxMiddleware,
  createToolGuardMiddleware,
  messageText,
  readBudget,
  readTokenUsage,
  recordConfirmedFailure
} from './executionMiddleware'
import { isRetryable, observeModelCallFailure, readRetryAfterMs } from './retryPolicy'
import { createInformationGainMiddleware } from './informationGainMiddleware'

export interface AgentMiddlewareInput {
  model: ChatModelCreation['model']
  profile: AgentExecutionProfile
  contextWindow: number
  maxOutputTokens: number
  /** 缺省表示摘要和正式请求都不安装单次超时。 */
  requestTimeoutMs?: number
  systemPrompt: string
  tools: readonly unknown[]
  extra?: readonly AnyAgentMiddleware[]
}

/**
 * 组装摘要、上下文编辑、技术重试和执行保护。
 * 总调用量只做统计，错误循环另行受限；已配置的时间和单次超时仍是硬边界。
 * 技术重试只有这一层；库的默认重试会吞掉取消和 Retry-After，因此不叠加上去。
 */
export function createAgentMiddleware(input: AgentMiddlewareInput): AnyAgentMiddleware[] {
  const allowed = allowedInputTokens({
    windowTokens: input.contextWindow,
    safetyFraction: input.profile.contextSafetyFraction,
    reservedOutputTokens: input.maxOutputTokens,
    inputBudgetTokens: input.profile.contextInputBudgetTokens
  })
  const guardInput = {
    systemPrompt: input.systemPrompt,
    tools: input.tools,
    contextWindow: input.contextWindow,
    maxOutputTokens: input.maxOutputTokens,
    safetyFraction: input.profile.contextSafetyFraction,
    inputBudgetTokens: input.profile.contextInputBudgetTokens
  }
  const middleware: AnyAgentMiddleware[] = [
    createBudgetGateMiddleware(),
    createRequiredContentMiddleware(guardInput),
    createSummarySnapshotMiddleware()
  ]
  if (allowed > 0) {
    middleware.push(
      summarizationMiddleware({
        model: guardSummaryModel(input.model, allowed) as never,
        trigger: { tokens: Math.max(1, Math.floor(allowed * 0.8)) },
        keep: { messages: 2 },
        trimTokensToSummarize: summaryMessageTokenLimit(allowed),
        tokenCounter: (messages) =>
          messages.reduce((sum, message) => sum + estimateTokens(messageText(message)), 0)
      }) as AnyAgentMiddleware,
      createSummaryRestoreMiddleware(),
      contextEditingMiddleware({
        edits: [
          new ClearToolUsesEdit({
            trigger: { tokens: Math.max(1, allowed) },
            keep: { messages: 2 },
            placeholder: '[工具结果已截断，此处不是完整内容]'
          })
        ]
      })
    )
  }
  middleware.push(
    createContextGuardMiddleware(guardInput),
    createToolChoiceRelaxMiddleware(),
    createTechnicalRetryMiddleware(input.profile),
    ...(input.extra ?? []),
    createFinalRequestGuard(guardInput),
    createInformationGainMiddleware(),
    createAttemptMeterMiddleware(),
    createModelTimeoutMiddleware(),
    createToolGuardMiddleware()
  )
  return middleware
}

/** 在摘要前保存当前消息。摘要失败时用这份快照恢复，不把错误文本写进状态。 */
function createSummarySnapshotMiddleware(): AnyAgentMiddleware {
  return createMiddleware({
    name: 'summarySnapshot',
    beforeModel: (state) => {
      const scope = executionScope.getStore()
      if (!scope) return undefined
      scope.summaryOutcome = 'idle'
      scope.summarySnapshot = [...state.messages]
      return undefined
    }
  })
}

/** 摘要模型失败时恢复快照。是否失败只看调用结果，不看摘要文本。 */
function createSummaryRestoreMiddleware(): AnyAgentMiddleware {
  return createMiddleware({
    name: 'summaryRestore',
    beforeModel: () => {
      const scope = executionScope.getStore()
      if (!scope || scope.summaryOutcome !== 'failed' || !scope.summarySnapshot) return undefined
      return {
        messages: [new RemoveMessage({ id: REMOVE_ALL_MESSAGES }), ...scope.summarySnapshot]
      }
    }
  })
}

/**
 * 摘要消息按可用输入裁剪，不再使用库默认的 4000 Token。
 * 包上摘要提示后的全文仍会在发出前再核对。
 */
function summaryMessageTokenLimit(allowed: number): number {
  return Math.max(1, allowed)
}

/**
 * 包装摘要模型，使摘要请求计入预算，并在抛错前记下失败。
 * 实际输入超过有效窗口时不向模型发送。
 * 摘要模型拿不到钩子运行时上下文，所以预算和本次时限只能从本次 invoke 的作用域取。
 * @throws {AppException | ActiveLimitExceeded | AttemptTimedOut} 预算、时间或单次调用失败。
 */
function guardSummaryModel(
  model: ChatModelCreation['model'],
  allowedInput: number
): {
  invoke(input: unknown, options?: { signal?: AbortSignal }): Promise<unknown>
} {
  return {
    /**
     * @throws {AppException | AttemptTimedOut | ActiveLimitExceeded} 预算不足、超时或模型失败。
     */
    async invoke(input: unknown, options?: { signal?: AbortSignal }): Promise<unknown> {
      const scope = executionScope.getStore()
      const budget = readBudget(scope?.context)
      if (scope) scope.summaryOutcome = 'failed'
      budget.assertModelAvailable()
      const summaryText = typeof input === 'string' ? input : JSON.stringify(input)
      if (estimateTokens(summaryText) > allowedInput) {
        throw new AppException({
          code: ErrorCodes.invalidRequest,
          msg: '摘要输入超过上下文预算'
        })
      }
      const remaining = budget.remainingActiveMs()
      const activeLimited = budget.limits.activeMs < Number.MAX_SAFE_INTEGER
      if (activeLimited && remaining <= 0) throw new ActiveLimitExceeded()
      const requestTimeoutMs = scope?.requestTimeoutMs
      const controller = new AbortController()
      const requestTimer =
        requestTimeoutMs === undefined
          ? undefined
          : setTimeout(() => controller.abort(new AttemptTimedOut()), requestTimeoutMs)
      const activeTimer =
        activeLimited && remaining < 2_147_483_647
          ? setTimeout(() => controller.abort(new ActiveLimitExceeded()), remaining)
          : undefined
      try {
        budget.consumeModelAttempt()
        notifyAgentProgress(scope?.context?.progress, {
          kind: 'model-start',
          at: Date.now(),
          usage: budget.usage
        })
        const signals = [options?.signal, controller.signal].filter(
          (signal): signal is AbortSignal => signal !== undefined
        )
        const signal = signals.length > 1 ? AbortSignal.any(signals) : signals[0]
        const result = await model.invoke(input as never, { ...options, signal } as never)
        const usage = readTokenUsage(result)
        if (usage) budget.consumeTokenUsage(usage)
        notifyAgentProgress(scope?.context?.progress, {
          kind: 'model-end',
          at: Date.now(),
          usage: budget.usage
        })
        if (scope) scope.summaryOutcome = 'succeeded'
        return result
      } catch (error) {
        const failedUsage = readTokenUsage(error)
        if (failedUsage) budget.consumeTokenUsage(failedUsage)
        notifyAgentProgress(scope?.context?.progress, {
          kind: 'model-end',
          at: Date.now(),
          usage: budget.usage
        })
        const observed = observeModelCallFailure(error)
        recordConfirmedFailure(budget, observed)
        throw observed
      } finally {
        clearTimeout(requestTimer)
        clearTimeout(activeTimer)
      }
    }
  }
}

/**
 * 在唯一的技术重试边界上等待。等待可取消，并且不会短于 Retry-After。
 * @throws {ActiveLimitExceeded} 剩余活跃时间不够完成等待。
 */
function createTechnicalRetryMiddleware(profile: AgentExecutionProfile): AnyAgentMiddleware {
  return createMiddleware({
    name: 'technicalRetry',
    contextSchema: agentRunContextSchema,
    wrapModelCall: async (request, handler) => {
      const budget = readBudget(request.runtime.context)
      for (let attempt = 0; ; attempt += 1) {
        try {
          return await handler(request)
        } catch (error) {
          if (attempt >= profile.technicalRetryCount || !isRetryable(error)) throw error
          const retryAfterMs = readRetryAfterMs(error)
          const delay = Math.max(profile.technicalRetryDelayMs * 2 ** attempt, retryAfterMs ?? 0)
          if (delay > budget.remainingActiveMs()) throw new ActiveLimitExceeded(error)
          await waitWithSignal(delay, request.runtime.signal)
        }
      }
    }
  })
}
