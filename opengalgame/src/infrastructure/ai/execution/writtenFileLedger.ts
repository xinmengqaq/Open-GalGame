import type { ExecutionBudget } from './ExecutionBudget'

export interface WrittenFileFact {
  readonly path: string
  readonly version: string
}

const writtenFiles = new WeakMap<ExecutionBudget, WrittenFileFact[]>()

export function beginWrittenFileLedger(budget: ExecutionBudget): void {
  writtenFiles.set(budget, [])
}

export function recordWrittenFile(budget: ExecutionBudget, fact: WrittenFileFact): void {
  const current = writtenFiles.get(budget)
  if (current) current.push(fact)
  else writtenFiles.set(budget, [fact])
}

export function writtenFileFacts(budget: ExecutionBudget): readonly WrittenFileFact[] {
  return writtenFiles.get(budget) ?? []
}
