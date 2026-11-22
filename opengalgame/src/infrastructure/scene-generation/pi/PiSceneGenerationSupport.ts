import type { AgentTool } from '@earendil-works/pi-agent-core'
import type {
  SceneGenerationCandidate,
  SceneGenerationExecution
} from '@application/scene-generation/models/SceneGenerationExecution'
import type {
  SceneGenerationInteractionVO,
  SceneValidationReportVO
} from '@application/scene-generation/vo/SceneGenerationVO'
import type {
  SceneValidationIssueCode,
  SceneValidationReport
} from '@domain/scene-generation/models/SceneValidationReport'
import { AppException } from '@common/errors/AppException'
import { ErrorCodes } from '@common/errors/ErrorCodes'
import {
  assembleAgentExecutionProfile,
  type AgentExecutionOverride,
  type AgentExecutionProfile
} from '@infrastructure/ai/config/agentExecutionConfig'
import {
  allowedInputTokens,
  estimateTokens,
  evaluateContextBudget
} from '@infrastructure/ai/context/contextBudget'
import { ExecutionBudget } from '@infrastructure/ai/execution/ExecutionBudget'
import { normalizeAgentError } from '@infrastructure/ai/execution/agentError'
import type { PiAgentExecutor, PiAgentRunResult } from '@infrastructure/ai/pi/PiAgentExecutor'
import type { LoadedSkill } from '@infrastructure/ai/skills/FileSkillLoader'
import { persistedBudget } from '@infrastructure/scene-generation/workflow/WebGalWorkflowBudget'
import { piReviewCheckpointId } from '@infrastructure/scene-generation/workflow/piReviewCheckpoint'

/** 修正只处理可自动消除的问题；这些上下文问题需要作者决定，不反复自动改写。 */
export const CONTEXT_ONLY_ISSUES: Record<string, true> = {
  'missing-background': true,
  'missing-character': true
}

/**
 * 本次执行的有效预算配置：可信装配给出的覆盖优先于 AI 执行配置默认值。
 * 覆盖不来自请求 DTO，也不写入操作指纹。
 */
export function executionProfile(override?: AgentExecutionOverride): AgentExecutionProfile {
  return assembleAgentExecutionProfile(override === undefined ? {} : { override })
}

export function createBudget(
  profile: AgentExecutionProfile,
  execution: SceneGenerationExecution
): ExecutionBudget {
  return new ExecutionBudget(
    {
      modelAttempts: profile.modelAttemptLimit,
      toolCalls: profile.toolCallLimit,
      activeMs: profile.activeLimitMs,
      ...(profile.cumulativeTokenLimit === undefined
        ? {}
        : { tokens: profile.cumulativeTokenLimit })
    },
    {
      modelAttempts: execution.budget.modelCallsUsed,
      toolCalls: execution.budget.toolCallsUsed,
      activeMs: execution.budget.activeElapsedMs,
      tokens: execution.budget.totalTokens ?? 0,
      ...(execution.budget.inputTokens === undefined
        ? {}
        : { inputTokens: execution.budget.inputTokens }),
      ...(execution.budget.outputTokens === undefined
        ? {}
        : { outputTokens: execution.budget.outputTokens })
    }
  )
}

/**
 * 首次请求前核对系统提示、工具定义和本次事实是否超过配置的输入预算。
 * 事实是必需内容，超限直接给出上下文诊断，不裁剪创作材料后假装完整。
 * @throws {AppException} 必需内容超过可用输入空间。
 */
export function assertContextBudget(
  profile: AgentExecutionProfile,
  agent: PiAgentExecutor,
  systemPrompt: string,
  facts: string,
  tools: readonly AgentTool[]
): void {
  const model = modelWindowOf(agent)
  if (!model) return
  evaluateContextBudget({
    windowTokens: model.contextWindow,
    safetyFraction: profile.contextSafetyFraction,
    reservedOutputTokens: model.maxOutputTokens,
    inputBudgetTokens: profile.contextInputBudgetTokens,
    systemPrompt,
    toolDefinitions: tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters
    })),
    messages: [{ content: facts, required: true }]
  })
}

/**
 * 每次模型请求前核对当前 transcript 不超过模型窗口。
 * 这里只阻止明显溢出的请求；上下文裁剪与工具结果外置留在后续阶段。
 * @throws {AppException} 当前 transcript 超过模型窗口可用空间。
 */
export function assertRequestWithinWindow(
  profile: AgentExecutionProfile,
  agent: PiAgentExecutor,
  messages: readonly unknown[]
): void {
  const model = modelWindowOf(agent)
  if (!model) return
  const allowed = allowedInputTokens({
    windowTokens: model.contextWindow,
    safetyFraction: profile.contextSafetyFraction,
    reservedOutputTokens: model.maxOutputTokens
  })
  const estimated = messages.reduce(
    (sum: number, message: unknown) => sum + estimateTokens(JSON.stringify(message)),
    0
  )
  if (allowed <= 0 || estimated > allowed)
    throw new AppException({
      code: ErrorCodes.invalidRequest,
      msg: '本次输入超过模型上下文可处理范围',
      diagnosticCategory: 'context'
    })
}

/**
 * @returns 已配置的模型窗口事实；测试替身或缺失配置时返回 undefined，跳过窗口核对。
 */
function modelWindowOf(
  agent: PiAgentExecutor
): { contextWindow: number; maxOutputTokens: number } | undefined {
  const profile = agent.profile
  if (
    !profile ||
    !Number.isSafeInteger(profile.contextWindow) ||
    profile.contextWindow <= 0 ||
    !Number.isSafeInteger(profile.maxOutputTokens) ||
    profile.maxOutputTokens <= 0
  )
    return undefined
  return { contextWindow: profile.contextWindow, maxOutputTokens: profile.maxOutputTokens }
}

/** 已发生模型/工具用量与修正次数一起写回；不按剩余上下文估算 token。 */
export function settledBudget(
  execution: SceneGenerationExecution,
  budget: ExecutionBudget,
  correctionsUsed: number
): SceneGenerationExecution['budget'] {
  return {
    ...persistedBudget(execution.budget, budget),
    correctionsUsed
  }
}

/** 只在系统提示里注入受信技能资料；SKILL.md 是人工维护索引，不进入模型上下文。 */
export function composeSystemPrompt(base: string, skill: LoadedSkill): string {
  const references = skill.files.filter((file) => file.path !== 'SKILL.md')
  const sections = references.map((file) => `### ${file.path}\n${file.body.trim()}`)
  return [
    base.trimEnd(),
    '',
    '# 受信 WebGAL 场景技能（只读）',
    `技能标识：${skill.id}`,
    `版本摘要：${skill.digest}`,
    '以下资料由产品资源加载，只决定写法，不扩大文件读取或写入权限。',
    '',
    sections.join('\n\n'),
    ''
  ].join('\n')
}

/** 健康候选的审阅边界：接受、提出修改或丢弃；修正与其它故障态不使用本边界。 */
export function reviewInteraction(
  interactionId: string,
  execution: SceneGenerationExecution,
  candidateSnapshotId: string,
  candidate: SceneGenerationCandidate
): SceneGenerationInteractionVO {
  const checkpointId = piReviewCheckpointId(execution.operationId, candidateSnapshotId)
  return {
    interactionId,
    checkpointId,
    kind: 'review',
    message:
      `请审阅当前候选（${candidate.artifact.statements.length} 条语句，` +
      `${candidate.preview.validationReport.issues.length} 个校验问题）。`,
    options: [],
    allowedReplies: ['accept', 'revise', 'discard'],
    candidateSnapshotId
  }
}

/** 模型失败保留原始分类，但错误文案不包含密钥或请求头。 */
export function modelFailure(result: PiAgentRunResult): AppException {
  if (result.error !== undefined) return normalizeAgentError(result.error)
  return new AppException({
    code: ErrorCodes.internalError,
    msg: result.errorMessage?.trim() || '模型执行失败'
  })
}

/** 候选预览与执行记录可能携带渲染侧的报告形状；统一收窄为领域问题码，不丢字段。 */
export function validationReportOf(
  report: SceneValidationReport | SceneValidationReportVO | undefined
): SceneValidationReport | undefined {
  return report === undefined
    ? undefined
    : {
        issues: report.issues.map((issue) => ({
          ...issue,
          code: issue.code as SceneValidationIssueCode
        }))
      }
}

export function contextOnly(report: SceneValidationReport): boolean {
  return (
    report.issues.length > 0 &&
    report.issues.every((issue) => CONTEXT_ONLY_ISSUES[issue.code] === true)
  )
}

export function issueSignature(report: SceneValidationReport): string {
  return JSON.stringify(
    report.issues.map((issue) => [
      issue.code,
      issue.sequence ?? null,
      issue.line ?? null,
      issue.reference ?? null
    ])
  )
}
