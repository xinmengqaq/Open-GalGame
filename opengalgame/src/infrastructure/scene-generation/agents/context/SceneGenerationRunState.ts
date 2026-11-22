import { estimateTokens } from '@infrastructure/ai/context/contextBudget'
import { ExecutionBudget } from '@infrastructure/ai/execution/ExecutionBudget'
import { readLedgerBlock } from '@infrastructure/ai/execution/ReadLedger'
import { writtenFileFacts } from '@infrastructure/ai/execution/writtenFileLedger'

const runStateTokenLimit = 200

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
    ? '提交或报告阻塞：不再读取或改写文件'
    : writes.length > 0
      ? '候选已写入本轮：直接结束本轮；无法继续时调用 reportBlocked，不要重复读取未变化的候选'
      : authoritative.length > 0
        ? '本轮尚未写入：先改写候选，写完后再结束本轮'
        : repair
          ? '先读取源候选，再作最小修改；改完即结束本轮或调用 reportBlocked；不要再请求提问'
          : '写出候选；需要用户决定时调用 requestClarification，无法继续时调用 reportBlocked'
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

function candidateLine(path: string, version: string): string {
  const separator = version.indexOf(':')
  const bytesText = separator > 0 ? version.slice(0, separator) : ''
  if (!/^[1-9]\d*$|^0$/.test(bytesText)) return path
  const bytes = Number(bytesText)
  if (!Number.isSafeInteger(bytes)) return path
  return `${path}（${bytes} bytes，版本 ${version}）`
}
