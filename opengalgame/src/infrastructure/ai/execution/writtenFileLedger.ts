import type { ExecutionBudget } from './ExecutionBudget'

export interface WrittenFileFact {
  readonly path: string
  readonly version: string
}

const writtenFiles = new WeakMap<ExecutionBudget, WrittenFileFact[]>()

/** 开始记录这一次执行的成功写入。上一次执行留在同一预算上的记录不会混入。 */
export function beginWrittenFileLedger(budget: ExecutionBudget): void {
  writtenFiles.set(budget, [])
}

/** 记下一次已经成功落盘的写入。调用方只在文件工具返回版本后记录。 */
export function recordWrittenFile(budget: ExecutionBudget, fact: WrittenFileFact): void {
  const current = writtenFiles.get(budget)
  if (current) current.push(fact)
  else writtenFiles.set(budget, [fact])
}

/**
 * @returns 写入事实。尚未开始记录时为空。
 */
export function writtenFileFacts(budget: ExecutionBudget): readonly WrittenFileFact[] {
  return writtenFiles.get(budget) ?? []
}
