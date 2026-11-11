import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { cleanupWorkflowState } from '@infrastructure/workflow/cleanup/cleanupWorkflowState'
import { FileCheckpointSaver } from '@infrastructure/workflow/checkpoints/FileCheckpointSaver'
import {
  assessContinuation,
  confirmBranchStart,
  forkWorkflowBranch,
  readWorkflowHistory
} from '@infrastructure/workflow/history/workflowHistory'
import { langGraphThreadKey } from '@infrastructure/workflow/WorkflowIdentity'
import type { DurableEffectRecord } from '@infrastructure/workflow/DurableEffectRecord'

import {
  compileCounter,
  identity,
  removeTemporaryDirectories,
  temporaryDirectory
} from './workflowFixture'

afterEach(async () => {
  await removeTemporaryDirectories()
})

describe('工作流历史与分叉', () => {
  it('历史读取不写盘，也不修改正式工程', async () => {
    const root = await temporaryDirectory()
    const projectRoot = join(root, 'official-project')
    await mkdir(projectRoot, { recursive: true })
    const projectFile = join(projectRoot, 'scene.txt')
    await writeFile(projectFile, 'official', 'utf8')
    const saver = new FileCheckpointSaver(root)
    const current = identity()
    const graph = compileCounter(saver)
    await graph.invoke({ value: '' }, { configurable: { thread_id: langGraphThreadKey(current) } })
    const before = await snapshot(root)

    const history = await readWorkflowHistory(graph, current)
    const start = await confirmBranchStart(graph, current)

    expect(history.length).toBeGreaterThan(1)
    expect(history[0]?.parentCheckpointId).toBe(history[1]?.checkpointId)
    expect(start.checkpointId).toBe(history.at(-1)?.checkpointId)
    expect(await snapshot(root)).toEqual(before)
    expect(await readFile(projectFile, 'utf8')).toBe('official')
  })

  it('分叉保留原分支并生成新身份；缺少候选修订时不可继续', async () => {
    const root = await temporaryDirectory()
    const saver = new FileCheckpointSaver(root)
    const source = identity()
    const graph = compileCounter(saver)
    await graph.invoke({ value: '' }, { configurable: { thread_id: langGraphThreadKey(source) } })
    const history = await readWorkflowHistory(graph, source)
    const checkpointId = history[0]?.checkpointId
    if (!checkpointId) throw new Error('missing checkpoint')
    const originalFile = await findFile(root, `${checkpointId}.json`)
    const originalBytes = await readFile(originalFile)
    const write: DurableEffectRecord = {
      operationId: source.operationId,
      stepId: 'write-scene',
      inputDigest: 'input-1',
      status: 'completed',
      kind: 'fileWrite',
      resultDigest: 'result-1'
    }

    expect(assessContinuation([write])).toEqual({
      continuable: false,
      reason: '已发生写入但缺少候选修订，不能继续'
    })
    const blocked = await forkWorkflowBranch({
      graph,
      saver,
      source,
      checkpointId,
      effects: [write],
      branchId: 'branch-blocked',
      operationId: 'operation-blocked'
    })
    expect(blocked.continuable).toBe(false)
    expect(blocked.identity.branchId).toBe('branch-blocked')
    expect(source.branchId).toBe('branch-a')
    const { stat } = await import('node:fs/promises')
    await expect(
      stat(
        join(
          root,
          'projects',
          source.projectId,
          'threads',
          source.threadId,
          'branches',
          'branch-blocked'
        )
      )
    ).rejects.toMatchObject({ code: 'ENOENT' })

    const forked = await forkWorkflowBranch({
      graph,
      saver,
      source,
      checkpointId,
      effects: [],
      branchId: 'branch-fork',
      operationId: 'operation-fork'
    })
    expect(forked.continuable).toBe(true)
    expect(forked.identity.branchId).toBe('branch-fork')
    expect(forked.identity.operationId).toBe('operation-fork')
    expect(source.branchId).toBe('branch-a')
    expect(await readFile(originalFile)).toEqual(originalBytes)
    expect(
      await findFile(
        join(
          root,
          'projects',
          source.projectId,
          'threads',
          source.threadId,
          'branches',
          'branch-fork'
        ),
        `${checkpointId}.json`
      )
    ).toContain('branch-fork')
  })

  it('分叉后清理原分支，新分支仍能恢复检查点和外置内容', async () => {
    const root = await temporaryDirectory()
    const saver = new FileCheckpointSaver(root)
    const source = identity()
    const graph = compileCounter(saver)
    await graph.invoke({ value: '' }, { configurable: { thread_id: langGraphThreadKey(source) } })
    const history = await readWorkflowHistory(graph, source)
    const checkpointId = history[0]?.checkpointId
    if (!checkpointId) throw new Error('missing checkpoint')
    await saver.writeExternalContent(source, 'shared-content', Buffer.from('kept'))
    await saver.associate(source, checkpointId, {
      inputDigest: 'digest-1',
      externalContentIds: ['shared-content'],
      candidateRevision: 'abc1234',
      operationId: source.operationId
    })

    const forked = await forkWorkflowBranch({
      graph,
      saver,
      source,
      checkpointId,
      effects: [],
      branchId: 'branch-fork',
      operationId: 'operation-fork'
    })
    await cleanupWorkflowState({
      stateRoot: root,
      projectId: source.projectId,
      threadId: source.threadId,
      branchIds: [source.branchId]
    })

    const loaded = await saver.getTuple({
      configurable: {
        thread_id: langGraphThreadKey(forked.identity),
        checkpoint_id: checkpointId
      }
    })
    const association = await saver.readAssociation(forked.identity, checkpointId)
    expect(loaded?.checkpoint.channel_values.value).toBe('one-two')
    expect(association).toMatchObject({
      inputDigest: 'digest-1',
      externalContentIds: ['shared-content'],
      candidateRevision: 'abc1234',
      operationId: 'operation-fork'
    })
    expect(
      await readFile(
        join(
          root,
          'projects',
          source.projectId,
          'threads',
          source.threadId,
          'context',
          'shared-content'
        )
      )
    ).toEqual(Buffer.from('kept'))
  })
})

async function snapshot(directory: string): Promise<string[]> {
  const { readdir } = await import('node:fs/promises')
  const names = await readdir(directory, { recursive: true })
  return names.map(String).sort()
}

async function findFile(directory: string, suffix: string): Promise<string> {
  const { readdir } = await import('node:fs/promises')
  const { join: joinPath } = await import('node:path')
  const names = await readdir(directory, { recursive: true })
  const found = names
    .map(String)
    .find((name) => name.endsWith(suffix) || name.replaceAll('\\', '/').endsWith(suffix))
  if (!found) throw new Error(`missing ${suffix}`)
  return found.includes(':') || found.startsWith('/') || found.startsWith('\\')
    ? found
    : joinPath(directory, found)
}
