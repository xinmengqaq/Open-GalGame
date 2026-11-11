import { mkdir, readFile, stat, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { emptyCheckpoint, type CheckpointMetadata } from '@langchain/langgraph-checkpoint'

import { ErrorCodes } from '@common/errors/ErrorCodes'
import { cleanupWorkflowState } from '@infrastructure/workflow/cleanup/cleanupWorkflowState'
import { FileCheckpointSaver } from '@infrastructure/workflow/checkpoints/FileCheckpointSaver'
import { recordOperationPhase } from '@infrastructure/workflow/checkpoints/checkpointPath'
import { langGraphThreadKey } from '@infrastructure/workflow/WorkflowIdentity'
import { WorkflowError } from '@infrastructure/workflow/WorkflowError'

import { identity, removeTemporaryDirectories, temporaryDirectory } from './workflowFixture'

const metadata = { source: 'loop', step: 0, parents: {} } satisfies CheckpointMetadata

afterEach(async () => {
  await removeTemporaryDirectories()
})

describe('工作流状态清理', () => {
  it('仍被其他分支引用的检查点和外置内容不会被清理', async () => {
    const root = await temporaryDirectory()
    const projectRoot = join(root, 'official-project')
    await mkdir(projectRoot, { recursive: true })
    const projectFile = join(projectRoot, 'scene.txt')
    await writeFile(projectFile, 'official', 'utf8')
    const saver = new FileCheckpointSaver(root)
    const branchA = identity({ branchId: 'branch-a', operationId: 'operation-a' })
    const branchB = identity({ branchId: 'branch-b', operationId: 'operation-b' })
    const kept = emptyCheckpoint()
    const disposable = emptyCheckpoint()
    await saver.put(
      { configurable: { thread_id: langGraphThreadKey(branchA) } },
      kept,
      metadata,
      {}
    )
    await saver.put(
      { configurable: { thread_id: langGraphThreadKey(branchA) } },
      disposable,
      metadata,
      {}
    )
    await saver.put(
      { configurable: { thread_id: langGraphThreadKey(branchB), checkpoint_id: kept.id } },
      emptyCheckpoint(),
      metadata,
      {}
    )
    await saver.writeExternalContent(branchA, 'shared-content', Buffer.from('shared'))
    await saver.writeExternalContent(branchA, 'orphan-content', Buffer.from('orphan'))
    await saver.associate(branchA, kept.id, {
      externalContentIds: ['shared-content'],
      operationId: 'operation-a'
    })
    await saver.associate(
      branchB,
      (await saver.getTuple({ configurable: { thread_id: langGraphThreadKey(branchB) } }))!
        .checkpoint.id,
      {
        externalContentIds: ['shared-content']
      }
    )
    const otherThread = identity({ threadId: 'thread-b' })
    const other = emptyCheckpoint()
    await saver.put(
      { configurable: { thread_id: langGraphThreadKey(otherThread) } },
      other,
      metadata,
      {}
    )

    const result = await cleanupWorkflowState({
      stateRoot: root,
      projectId: branchA.projectId,
      threadId: branchA.threadId,
      branchIds: ['branch-a'],
      projectRoot
    })

    expect(result.removed.some((path) => path.includes(kept.id))).toBe(false)
    expect(result.removed.some((path) => path.includes('shared-content'))).toBe(false)
    expect(result.removed.some((path) => path.includes('orphan-content'))).toBe(true)
    expect(result.removed.some((path) => path.includes(disposable.id))).toBe(true)
    await expect(
      saver.getTuple({
        configurable: { thread_id: langGraphThreadKey(branchA), checkpoint_id: kept.id }
      })
    ).resolves.toBeTruthy()
    await expect(
      saver.getTuple({
        configurable: { thread_id: langGraphThreadKey(otherThread), checkpoint_id: other.id }
      })
    ).resolves.toBeTruthy()
    expect(await readFile(projectFile, 'utf8')).toBe('official')
  })

  it('运行中、等待人工或待恢复操作不会被清理', async () => {
    const root = await temporaryDirectory()
    const current = identity()
    await writeFile(join(root, 'placeholder'), 'x')
    for (const phase of ['running', 'waiting', 'pendingRecovery'] as const) {
      const stateRoot = await temporaryDirectory()
      await recordOperationPhase(stateRoot, current, phase)
      await mkdir(
        join(stateRoot, 'projects', current.projectId, 'threads', current.threadId, 'context'),
        { recursive: true }
      )
      await writeFile(
        join(
          stateRoot,
          'projects',
          current.projectId,
          'threads',
          current.threadId,
          'context',
          'orphan-content'
        ),
        'orphan'
      )
      await expect(
        cleanupWorkflowState({
          stateRoot,
          projectId: current.projectId,
          threadId: current.threadId,
          branchIds: [current.branchId]
        })
      ).rejects.toMatchObject({ code: ErrorCodes.operationConflict })
      expect(
        await readFile(
          join(
            stateRoot,
            'projects',
            current.projectId,
            'threads',
            current.threadId,
            'context',
            'orphan-content'
          ),
          'utf8'
        )
      ).toBe('orphan')
    }
  })

  it('清理失败时保留原始错误和已完成的结果', async () => {
    const root = await temporaryDirectory()
    const current = identity()
    const context = join(
      root,
      'projects',
      current.projectId,
      'threads',
      current.threadId,
      'context'
    )
    await mkdir(context, { recursive: true })
    await writeFile(join(context, 'orphan-one'), 'one')
    await writeFile(join(context, 'orphan-two'), 'two')
    const diskError = new Error('disk-failed')
    let calls = 0

    const error = await cleanupWorkflowState({
      stateRoot: root,
      projectId: current.projectId,
      threadId: current.threadId,
      branchIds: [current.branchId],
      removeFile: async (path) => {
        calls += 1
        if (calls === 2) throw diskError
        const { rm } = await import('node:fs/promises')
        await rm(path, { force: true })
      }
    }).catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(WorkflowError)
    expect(error).toMatchObject({
      category: 'cleanupFailed',
      cause: diskError
    })
    expect((error as WorkflowError).completed).toHaveLength(1)
    expect((error as WorkflowError).category).not.toBe('executionFailed')
  })

  it('不清理候选 Git 修订库，并保留完整祖先链和删除待写入', async () => {
    const root = await temporaryDirectory()
    const saver = new FileCheckpointSaver(root)
    const branchA = identity({ branchId: 'branch-a' })
    const branchB = identity({ branchId: 'branch-b' })
    const rootCheckpoint = emptyCheckpoint()
    const middle = emptyCheckpoint()
    const disposable = emptyCheckpoint()
    const keyA = langGraphThreadKey(branchA)
    const keyB = langGraphThreadKey(branchB)
    await saver.put({ configurable: { thread_id: keyA } }, rootCheckpoint, metadata, {})
    await saver.put(
      { configurable: { thread_id: keyA, checkpoint_id: rootCheckpoint.id } },
      middle,
      metadata,
      {}
    )
    await saver.put({ configurable: { thread_id: keyA } }, disposable, metadata, {})
    await saver.putWrites(
      { configurable: { thread_id: keyA, checkpoint_id: disposable.id, checkpoint_ns: '' } },
      [['channel', 'gone']],
      'task-1'
    )
    await saver.put(
      { configurable: { thread_id: keyB, checkpoint_id: middle.id } },
      emptyCheckpoint(),
      metadata,
      {}
    )
    const revisions = join(
      root,
      'projects',
      branchA.projectId,
      'threads',
      branchA.threadId,
      'revisions'
    )
    await mkdir(join(revisions, 'objects'), { recursive: true })
    await writeFile(join(revisions, 'HEAD'), 'ref: refs/heads/revisions\n', 'utf8')
    await writeFile(join(revisions, 'objects', 'pack'), 'git-object', 'utf8')

    await cleanupWorkflowState({
      stateRoot: root,
      projectId: branchA.projectId,
      threadId: branchA.threadId,
      branchIds: ['branch-a']
    })

    await expect(
      saver.getTuple({ configurable: { thread_id: keyA, checkpoint_id: rootCheckpoint.id } })
    ).resolves.toBeTruthy()
    await expect(
      saver.getTuple({ configurable: { thread_id: keyA, checkpoint_id: middle.id } })
    ).resolves.toBeTruthy()
    await expect(
      saver.getTuple({ configurable: { thread_id: keyA, checkpoint_id: disposable.id } })
    ).resolves.toBeUndefined()
    await expect(
      stat(
        join(
          root,
          'projects',
          branchA.projectId,
          'threads',
          branchA.threadId,
          'branches',
          'branch-a',
          'checkpoints',
          '_',
          'writes',
          disposable.id
        )
      )
    ).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readFile(join(revisions, 'HEAD'), 'utf8')).toContain('refs/heads/revisions')
    expect(await readFile(join(revisions, 'objects', 'pack'), 'utf8')).toBe('git-object')
  })

  it('线程目录内的联接不能把清理带到其他线程', async () => {
    const root = await temporaryDirectory()
    const current = identity()
    const other = identity({ threadId: 'thread-b' })
    const otherContext = join(
      root,
      'projects',
      other.projectId,
      'threads',
      other.threadId,
      'context'
    )
    const thisContext = join(
      root,
      'projects',
      current.projectId,
      'threads',
      current.threadId,
      'context'
    )
    await mkdir(otherContext, { recursive: true })
    await mkdir(join(root, 'projects', current.projectId, 'threads', current.threadId), {
      recursive: true
    })
    await writeFile(join(otherContext, 'other-content'), 'keep', 'utf8')
    await symlink(otherContext, thisContext, 'junction')

    await expect(
      cleanupWorkflowState({
        stateRoot: root,
        projectId: current.projectId,
        threadId: current.threadId,
        branchIds: [current.branchId]
      })
    ).rejects.toMatchObject({ code: ErrorCodes.forbidden })
    expect(await readFile(join(otherContext, 'other-content'), 'utf8')).toBe('keep')
  })
})
