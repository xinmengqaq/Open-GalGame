import { describe, expect, it } from 'vitest'

import { ExecutionBudget } from '@infrastructure/ai/execution/ExecutionBudget'
import {
  beginReadLedger,
  candidateReadFacts,
  noteCandidateRead,
  readLedgerBlock
} from '@infrastructure/ai/execution/ReadLedger'

function budget(): ExecutionBudget {
  return new ExecutionBudget({ modelAttempts: 8, toolCalls: 8, activeMs: 900000 })
}

describe('候选回读账本', () => {
  it('开始记录后没有事实，块文本为空', () => {
    const current = budget()
    beginReadLedger(current)
    expect(candidateReadFacts(current)).toEqual([])
    expect(readLedgerBlock(current)).toBe('')
  })

  it('首次读取、未变化、变化和重置的判定', () => {
    const current = budget()
    beginReadLedger(current)

    expect(
      noteCandidateRead(current, { path: 'note.txt', start: 0, end: 10, version: 'v1' }, '0123456789')
    ).toBe('first')
    expect(
      noteCandidateRead(current, { path: 'note.txt', start: 0, end: 10, version: 'v1' }, '0123456789')
    ).toBe('unchanged')
    expect(
      noteCandidateRead(current, { path: 'note.txt', start: 0, end: 10, version: 'v2' }, 'abcdefghij')
    ).toBe('changed')

    const changed = candidateReadFacts(current)
    expect(changed).toHaveLength(1)
    expect(changed[0]).toMatchObject({ path: 'note.txt', start: 0, end: 10, version: 'v2' })
    expect(changed[0]?.repeat).toBe('changed')
    const changedDigest = changed[0]?.digest

    expect(
      noteCandidateRead(current, { path: 'note.txt', start: 0, end: 10, version: 'v2' }, 'ABCDEFGHIJ')
    ).toBe('changed')
    expect(candidateReadFacts(current)[0]?.digest).not.toBe(changedDigest)

    beginReadLedger(current)
    expect(candidateReadFacts(current)).toHaveLength(0)
    expect(
      noteCandidateRead(current, { path: 'note.txt', start: 0, end: 10, version: 'v1' }, '0123456789')
    ).toBe('first')
  })

  it('块文本只保留最近五行，未变化行带说明', () => {
    const current = budget()
    beginReadLedger(current)
    for (let index = 0; index < 7; index += 1) {
      noteCandidateRead(
        current,
        { path: 'note.txt', start: index * 10, end: index * 10 + 10, version: 'v1' },
        `content-${index}`
      )
    }
    noteCandidateRead(
      current,
      { path: 'note.txt', start: 60, end: 70, version: 'v1' },
      'content-6'
    )

    const lines = readLedgerBlock(current).split('\n')
    expect(lines).toHaveLength(5)
    expect(lines[0]).toBe('- note.txt 20-30')
    expect(lines[4]).toBe('- note.txt 60-70（已读，内容未变）')
    expect(lines).not.toContain('- note.txt 0-10')
  })
})
