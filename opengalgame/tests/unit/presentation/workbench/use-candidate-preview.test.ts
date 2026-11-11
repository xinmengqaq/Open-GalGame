import { describe, expect, it } from 'vitest'

import { candidatePreviewTargetKey } from '@presentation/pages/workbench/drawer/candidate/candidatePreviewState'
import {
  candidatePreviewActivation,
  candidatePreviewOpenDecision
} from '@presentation/pages/workbench/drawer/candidate/useCandidatePreview'

const first = candidatePreviewTargetKey({
  projectId: 'project-1',
  sceneId: 'scene-1',
  operationId: 'operation-1',
  threadId: 'thread-1',
  branchId: 'branch-1',
  checkpointId: 'checkpoint-1',
  candidateSnapshotId: '0123456789abcdef'
})

const second = candidatePreviewTargetKey({
  ...{
    projectId: 'project-1',
    sceneId: 'scene-1',
    operationId: 'operation-1',
    threadId: 'thread-1',
    branchId: 'branch-1',
    checkpointId: 'checkpoint-1'
  },
  candidateSnapshotId: 'fedcba9876543210'
})

describe('候选预览激活锁存', () => {
  it('未激活不打开，激活后打开，切走不重开，换候选后重新锁存', () => {
    const hidden = candidatePreviewActivation('', first, false)
    const shown = candidatePreviewActivation(hidden.openedTarget, first, true)
    const away = candidatePreviewActivation(shown.openedTarget, first, false)
    const back = candidatePreviewActivation(away.openedTarget, first, true)
    const changed = candidatePreviewActivation(back.openedTarget, second, true)
    expect([hidden.open, shown.open, away.open, back.open, changed.open]).toEqual([
      false,
      true,
      false,
      false,
      true
    ])
    expect(changed.openedTarget).toBe(second)
  })

  it('失败操作的只读候选与按画布重试的新操作分别锁存', () => {
    const failed = candidatePreviewTargetKey({
      projectId: 'project-1',
      sceneId: 'scene-1',
      operationId: 'operation-failed',
      threadId: 'thread-1',
      branchId: 'branch-1',
      checkpointId: 'checkpoint-1',
      candidateSnapshotId: '0123456789abcdef'
    })
    const retried = candidatePreviewTargetKey({
      projectId: 'project-1',
      sceneId: 'scene-1',
      operationId: 'operation-retried',
      threadId: 'thread-2',
      branchId: 'branch-1',
      checkpointId: 'checkpoint-1',
      candidateSnapshotId: '0123456789abcdef'
    })

    const opened = candidatePreviewActivation('', failed, true)
    const sameFailed = candidatePreviewActivation(opened.openedTarget, failed, true)
    const nextOperation = candidatePreviewActivation(sameFailed.openedTarget, retried, true)

    expect([opened.open, sameFailed.open, nextOperation.open]).toEqual([true, false, true])
    expect(nextOperation.openedTarget).toBe(retried)
  })

  it('同一目标重新打开会先清掉打开锁存，再重新发出请求', () => {
    const opened = candidatePreviewActivation('', first, true)
    const sameTarget = candidatePreviewOpenDecision(opened.openedTarget, first, true, false)
    const reopened = candidatePreviewOpenDecision(opened.openedTarget, first, true, true)

    expect(sameTarget.open).toBe(false)
    expect(reopened.open).toBe(true)
    expect(reopened.openedTarget).toBe(first)
  })
})
