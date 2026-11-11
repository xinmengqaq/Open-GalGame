import { describe, expect, it } from 'vitest'

import {
  isLatestDraftRevision,
  nextDraftRevision
} from '@presentation/pages/preview/previewDraftSequencer'

describe('实时草稿修订号', () => {
  it('只允许最新修订提交舞台结果', () => {
    let revision = 0
    revision = nextDraftRevision(revision)
    const first = revision
    revision = nextDraftRevision(revision)
    const second = revision

    expect(first).toBe(1)
    expect(second).toBe(2)
    expect(isLatestDraftRevision(second, first)).toBe(false)
    expect(isLatestDraftRevision(second, second)).toBe(true)
  })
})
