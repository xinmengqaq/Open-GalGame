import { createHash } from 'node:crypto'

import type { ExecutionBudget } from './ExecutionBudget'

export type CandidateReadRepeat = 'first' | 'unchanged' | 'changed'

export interface CandidateReadFact {
  readonly path: string
  readonly start: number
  readonly end: number
  readonly version: string
  readonly digest: string
  /** 该范围最近一次读取的判定。未变化后重复读取仍为 unchanged。 */
  readonly repeat: CandidateReadRepeat
}

interface LedgerState {
  facts: CandidateReadFact[]
}

const ledgers = new WeakMap<ExecutionBudget, LedgerState>()

export function beginReadLedger(budget: ExecutionBudget): void {
  ledgers.set(budget, { facts: [] })
}

function ensureLedger(budget: ExecutionBudget): LedgerState {
  const existing = ledgers.get(budget)
  if (existing !== undefined) return existing
  const created: LedgerState = { facts: [] }
  ledgers.set(budget, created)
  return created
}

export function noteCandidateRead(
  budget: ExecutionBudget,
  fact: Omit<CandidateReadFact, 'digest' | 'repeat'>,
  content: string
): CandidateReadRepeat {
  const ledger = ensureLedger(budget)
  const digest = createHash('sha256').update(content).digest('hex')
  const index = ledger.facts.findIndex(
    (entry) => entry.path === fact.path && entry.start === fact.start && entry.end === fact.end
  )
  const previous = index >= 0 ? ledger.facts[index] : undefined
  const repeat: CandidateReadRepeat =
    previous === undefined
      ? 'first'
      : previous.version === fact.version && previous.digest === digest
        ? 'unchanged'
        : 'changed'
  const next: CandidateReadFact = { ...fact, digest, repeat }
  if (index >= 0) ledger.facts[index] = next
  else ledger.facts.push(next)
  return repeat
}

export function candidateReadFacts(budget: ExecutionBudget): readonly CandidateReadFact[] {
  return ledgers.get(budget)?.facts ?? []
}

/** 最近 5 条回读事实，每行 `- <path> <start>-<end>`，未变化行追加 `（已读，内容未变）`。 */
export function readLedgerBlock(budget: ExecutionBudget): string {
  const facts = candidateReadFacts(budget)
  if (facts.length === 0) return ''
  return facts
    .slice(-5)
    .map((fact) => {
      const line = `- ${fact.path} ${fact.start}-${fact.end}`
      return fact.repeat === 'unchanged' ? `${line}（已读，内容未变）` : line
    })
    .join('\n')
}
