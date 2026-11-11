import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { ExecutionBudget } from '@infrastructure/ai/execution/ExecutionBudget'
import {
  beginReadLedger,
  candidateReadFacts,
  noteCandidateRead,
  readLedgerBlock
} from '@infrastructure/ai/execution/ReadLedger'
import { createWorkspaceFileTools } from '@infrastructure/ai/tools/WorkspaceFileTools'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

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

  it('范围读取工具在内容未变时只返回版本与 unchanged', async () => {
    const root = await mkdtemp(join(tmpdir(), 'read-ledger-'))
    roots.push(root)
    await writeFile(join(root, 'note.txt'), '0123456789abcdef')

    const current = budget()
    beginReadLedger(current)
    const readTool = createWorkspaceFileTools().find((entry) => entry.name === 'readTextRange')
    if (!readTool) throw new Error('缺少 readTextRange 工具')
    const context = { budget: current, workspace: { root, writable: true } }

    const first = await readTool.invoke({ path: 'note.txt', start: 0, maxChars: 100 }, { context })
    expect(first.content).toBe('0123456789abcdef')
    expect(first).toMatchObject({
      path: 'note.txt',
      start: 0,
      end: 16,
      complete: true,
      truncated: false
    })
    expect(first.unchanged).toBeUndefined()

    const second = await readTool.invoke(
      { path: 'note.txt', start: 0, maxChars: 100 },
      { context }
    )
    expect(second.content).toBe('')
    expect(second.unchanged).toBe(true)
    expect(second.version).toBe(first.version)
    expect(second).toMatchObject({ path: 'note.txt', start: 0, end: 16, complete: true })
    expect(candidateReadFacts(current)).toHaveLength(1)
    expect(candidateReadFacts(current)[0]?.repeat).toBe('unchanged')
  })
})
