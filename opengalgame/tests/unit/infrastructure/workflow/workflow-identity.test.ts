import { describe, expect, it } from 'vitest'

import { ErrorCodes } from '@common/errors/ErrorCodes'
import {
  assertCheckpointInScope,
  createCheckpointReference
} from '@infrastructure/workflow/CheckpointReference'
import {
  createForkIdentity,
  createWorkflowIdentity,
  langGraphThreadKey,
  scopeFromThreadKey
} from '@infrastructure/workflow/WorkflowIdentity'

const valid = {
  projectId: 'project-a',
  threadId: 'thread-a',
  branchId: 'branch-a',
  operationId: 'operation-a'
}

describe('工作流身份', () => {
  it('拒绝空值、路径片段和跨作用域引用', () => {
    expect(() => createWorkflowIdentity({ ...valid, threadId: '' })).toThrow(
      '工作流身份包含空值或非法路径片段'
    )
    expect(() => createWorkflowIdentity({ ...valid, branchId: '../other' })).toThrow(
      '工作流身份包含空值或非法路径片段'
    )
    expect(() => createWorkflowIdentity({ ...valid, projectId: 'a/b' })).toThrow(
      '工作流身份包含空值或非法路径片段'
    )
    expect(() => createWorkflowIdentity({ ...valid, operationId: 'a\\b' })).toThrow(
      '工作流身份包含空值或非法路径片段'
    )
    const current = createWorkflowIdentity(valid)
    const foreign = createCheckpointReference(
      createWorkflowIdentity({ ...valid, projectId: 'project-b' }),
      'checkpoint-a'
    )

    expect(createCheckpointReference(current, 'checkpoint-a').projectId).toBe('project-a')
    expect(() => assertCheckpointInScope(current, foreign)).toThrow('检查点引用超出当前作用域')
  })

  it('threadId 加 branchId 映射为不同的内部线程键，并且可以还原作用域', () => {
    const first = createWorkflowIdentity(valid)
    const otherBranch = createWorkflowIdentity({ ...valid, branchId: 'branch-b' })
    const otherThread = createWorkflowIdentity({ ...valid, threadId: 'thread-b' })
    const firstKey = langGraphThreadKey(first)
    const branchKey = langGraphThreadKey(otherBranch)
    const threadKey = langGraphThreadKey(otherThread)

    expect(firstKey).not.toBe(branchKey)
    expect(firstKey).not.toBe(threadKey)
    expect(firstKey).not.toContain('/')
    expect(firstKey).not.toContain('\\')
    expect(scopeFromThreadKey(firstKey)).toEqual({
      projectId: 'project-a',
      threadId: 'thread-a',
      branchId: 'branch-a'
    })
    expect(langGraphThreadKey(first)).toBe(firstKey)
    expect(() => scopeFromThreadKey('../projects/other')).toThrow(
      '工作流身份包含空值或非法路径片段'
    )
  })

  it('分叉生成新的分支和操作身份，不修改原身份', () => {
    const source = createWorkflowIdentity({ ...valid, checkpointId: 'old-checkpoint' })
    const forked = createForkIdentity(source, 'checkpoint-a', {
      branchId: 'branch-fork',
      operationId: 'operation-fork'
    })

    expect(source.branchId).toBe('branch-a')
    expect(source.operationId).toBe('operation-a')
    expect(forked.branchId).toBe('branch-fork')
    expect(forked.operationId).toBe('operation-fork')
    expect(forked.projectId).toBe(source.projectId)
    expect(forked.threadId).toBe(source.threadId)
    expect(forked.checkpointId).toBe('checkpoint-a')
    expect(langGraphThreadKey(forked)).not.toBe(langGraphThreadKey(source))
  })

  it('非法身份使用请求错误码', () => {
    expect(() => createWorkflowIdentity({ ...valid, threadId: '..' })).toThrow(
      expect.objectContaining({ code: ErrorCodes.invalidRequest })
    )
  })
})
