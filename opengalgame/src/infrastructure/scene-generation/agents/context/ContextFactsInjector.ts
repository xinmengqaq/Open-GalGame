import { ToolMessage } from '@langchain/core/messages'
import { createMiddleware, type AnyAgentMiddleware } from 'langchain'
import { AppException } from '@common/errors/AppException'
import { ErrorCodes } from '@common/errors/ErrorCodes'
import { estimateTokens } from '@infrastructure/ai/context/contextBudget'
import { ExecutionBudget } from '@infrastructure/ai/execution/ExecutionBudget'
import { ErrorBudgetExhausted } from '@infrastructure/ai/execution/executionErrors'
import { readLedgerBlock } from '@infrastructure/ai/execution/ReadLedger'
import { writtenFileFacts } from '@infrastructure/ai/execution/writtenFileLedger'

export const SCENE_FACTS_MESSAGE_ID = 'webgal-current-facts'

/**
 * 必需事实每轮进入模型请求，摘要和工具结果裁剪不能替代它。
 * 事实本身只作为受保护的消息出现一次，系统消息只补充每轮运行状态。
 */
export function createContextFactsInjector(): AnyAgentMiddleware {
  return createMiddleware({
    name: 'webgalSceneFacts',
    wrapModelCall: async (request, handler) => {
      if (!request.messages.some((message) => message.id === SCENE_FACTS_MESSAGE_ID))
        throw new AppException({ code: ErrorCodes.internalError, msg: '当前场景事实缺失' })
      const systemMessage = request.systemMessage.concat(runStateBlock(request.runtime.context))
      return handler({
        ...request,
        systemMessage
      })
    }
  })
}

const runStateTokenLimit = 200

/**
 * 每轮重注入的阶段、候选与回读事实。候选是否存在只认运行上下文的权威集合；
 * 本轮 written-file 账本只提供本轮新写入的路径与大小/版本，写入仍受 writablePaths 限制。
 * 不写入图状态或长期记忆。超过 200 token 时先丢回读行，再丢候选的大小与版本。
 * 修复重跑没有新写入时显示源候选修复起点，并禁止再请求提问。
 */
export function runStateBlock(context: unknown): string {
  const budget = contextBudget(context)
  const authoritative = writtenFilesOf(context) ?? []
  const writes = budget ? writtenFileFacts(budget) : []
  const latest = writes.at(-1)
  const candidatePaths =
    authoritative.length > 0
      ? [
          ...authoritative,
          ...writes.map((fact) => fact.path).filter((path) => !authoritative.includes(path))
        ]
      : latest
        ? [latest.path]
        : []
  const versions = new Map(writes.map((fact) => [fact.path, fact.version]))
  const detailed = candidatePaths
    .map((path) => {
      const version = versions.get(path)
      return version === undefined ? path : candidateLine(path, version)
    })
    .join('、')
  const plain = candidatePaths.join('、')
  const reads = budget ? readLedgerBlock(budget) : ''
  const mode = executionModeOf(context)
  const finalize = mode === 'finalize'
  const repair = mode === 'repair'
  const stage = finalize ? '收尾提交' : '撰写候选'
  const nextStep = finalize
    ? '提交或报告阻塞：无提交工具时直接输出 JSON；不再读取或改写文件'
    : writes.length > 0
      ? '提交或报告阻塞：无提交工具时直接输出 JSON；不要重复读取未变化的候选'
      : authoritative.length > 0
        ? '本轮尚未写入：先改写候选，写完后再提交'
        : repair
          ? '先读取源候选，再作最小修改；改完提交或报告阻塞（无提交工具时直接输出 JSON）；不要再请求提问'
          : '写出候选；需要用户决定时返回 request_clarification，无法继续时返回 report_blocked'
  const emptyCandidateText = repair ? '源候选可读（修复起点）' : '未写出'
  const render = (paths: string, withReads: boolean): string =>
    [
      '[运行状态]',
      `阶段：${stage}`,
      `候选：${paths || emptyCandidateText}`,
      ...(withReads ? [reads ? `候选回读：\n${reads}` : '候选回读：无'] : []),
      `下一步：${nextStep}`
    ].join('\n')
  let block = render(detailed, true)
  if (estimateTokens(block) > runStateTokenLimit) block = render(detailed, false)
  if (estimateTokens(block) > runStateTokenLimit) block = render(plain, false)
  return `\n\n${block}`
}

function writtenFilesOf(context: unknown): readonly string[] | undefined {
  if (!context || typeof context !== 'object' || !('writtenFiles' in context)) return undefined
  const value = context.writtenFiles
  if (!Array.isArray(value)) return undefined
  return value.filter((item): item is string => typeof item === 'string')
}

function contextBudget(context: unknown): ExecutionBudget | undefined {
  if (!context || typeof context !== 'object' || !('budget' in context)) return undefined
  return context.budget instanceof ExecutionBudget ? context.budget : undefined
}

function executionModeOf(context: unknown): string | undefined {
  if (!context || typeof context !== 'object' || !('executionMode' in context)) return undefined
  return typeof context.executionMode === 'string' ? context.executionMode : undefined
}

/** 版本冒号前是字节数。解析失败只保留路径，不猜测大小。 */
function candidateLine(path: string, version: string): string {
  const separator = version.indexOf(':')
  const bytesText = separator > 0 ? version.slice(0, separator) : ''
  if (!/^[1-9]\d*$|^0$/.test(bytesText)) return path
  const bytes = Number(bytesText)
  if (!Number.isSafeInteger(bytes)) return path
  return `${path}（${bytes} bytes，版本 ${version}）`
}

/** 工具权限和输入拒绝作为安全错误交回模型；取消、预算和技术失败继续向外传播。 */
export function createSceneToolErrorMiddleware(): AnyAgentMiddleware {
  return createMiddleware({
    name: 'webgalToolInputErrors',
    wrapToolCall: async (request, handler) => {
      try {
        return await handler(request)
      } catch (error) {
        if (
          error instanceof ErrorBudgetExhausted ||
          !(error instanceof AppException) ||
          (error.code !== ErrorCodes.forbidden && error.code !== ErrorCodes.invalidRequest)
        )
          throw error
        return new ToolMessage({
          content: error.message,
          tool_call_id: request.toolCall.id ?? '',
          name: request.toolCall.name,
          status: 'error'
        })
      }
    }
  })
}
