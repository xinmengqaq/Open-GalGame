import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import type { SceneGenerationExecution } from '@application/scene-generation/models/SceneGenerationExecution'
import { ErrorCodes } from '@common/errors/ErrorCodes'
import { SceneGenerationMemoryGatewayImpl } from '@infrastructure/scene-generation/memory/SceneGenerationMemoryGatewayImpl'
import { FileSceneGenerationExecutionRepositoryImpl } from '@infrastructure/scene-generation/execution/FileSceneGenerationExecutionRepositoryImpl'
import {
  generationInputDigest,
  readWebGalGenerationCheckpoint,
  webGalGenerationCompatibility
} from '@infrastructure/scene-generation/history/WebGalGenerationCheckpoint'
import { WebGalSceneGenerationHistoryReaderImpl } from '@infrastructure/scene-generation/history/WebGalSceneGenerationHistoryReaderImpl'
import { AiProjectFileSystemImpl } from '@infrastructure/ai/filesystem/AiProjectFileSystemImpl'
import { executionFromDocument } from '@infrastructure/scene-generation/execution/SceneGenerationExecutionDocument'
import { cleanupWorkflowState } from '@infrastructure/workflow/cleanup/cleanupWorkflowState'
import { LEGACY_CHECKPOINT_COMPATIBILITY } from '@infrastructure/workflow/checkpoints/checkpointCompatibility'
import { recordOperationPhase } from '@infrastructure/workflow/checkpoints/checkpointPath'
import { ReadOnlyGenerationCheckpointStore } from '@infrastructure/workflow/checkpoints/ReadOnlyCheckpointStore'
import { WorkflowError } from '@infrastructure/workflow/WorkflowError'

const roots: string[] = []
const CHECKPOINT_ID = 'checkpoint-1'
const PROJECT_ID = 'project-a'
const THREAD_ID = 'thread-a'
const BRANCH_ID = 'branch-a'
const OPERATION_ID = 'operation-a'

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

function executionFor(
  root: string,
  overrides: Partial<SceneGenerationExecution> = {}
): SceneGenerationExecution {
  return {
    projectId: PROJECT_ID,
    sceneId: 'scene-a',
    operationId: OPERATION_ID,
    threadId: THREAD_ID,
    branchId: BRANCH_ID,
    fingerprint: 'fingerprint-a',
    source: {
      projectId: PROJECT_ID,
      sceneId: 'scene-a',
      projectRoot: join(root, 'official-project'),
      sceneDirectory: 'game/scene',
      entryFile: 'start.txt'
    },
    inputSnapshot: {
      canvasId: 'canvas-a',
      arrangementVersion: 'arrangement-a',
      assets: [],
      documents: [],
      prompts: [
        {
          id: 'prompt-a',
          title: '开场',
          body: '写一句开场。',
          scopes: [{ kind: 'scene' }],
          usage: { targetIds: [] }
        }
      ],
      fieldBindings: [],
      relations: [],
      confirmedControls: []
    },
    policy: { maxCorrections: 1 },
    reviewCandidate: false,
    baseline: { commitId: 'baseline', affectedFiles: [], lockState: 'unlocked' },
    state: 'waiting',
    attempt: 0,
    sequence: 0,
    budget: {
      correctionsUsed: 0,
      modelCallsUsed: 0,
      toolCallsUsed: 0,
      activeElapsedMs: 0
    },
    replies: [],
    workspace: {
      workspaceId: 'workspace-a',
      rootDirectory: join(root, 'workspace'),
      sceneDirectory: 'game/scene'
    },
    ...overrides
  }
}

async function writeCheckpoint(
  store: ReadOnlyGenerationCheckpointStore,
  stateRoot: string,
  execution: SceneGenerationExecution,
  options: {
    checkpointId: string
    parentCheckpointId?: string
    externalContentIds?: readonly string[]
    operationId?: string
    writes?: readonly { name: string; content: string }[]
  }
): Promise<string> {
  const stored = executionFromDocument(execution)
  const checkpoint = {
    v: 4,
    id: options.checkpointId,
    ts: new Date().toISOString(),
    channel_values: {
      execution: stored,
      compatibility: webGalGenerationCompatibility(),
      summary: '历史摘要',
      unresolvedIssues: []
    },
    channel_versions: {
      execution: 1,
      compatibility: 1,
      summary: 1,
      unresolvedIssues: 1
    },
    versions_seen: {}
  }
  const [checkpointType, checkpointBytes] = await store.serde.dumpsTyped(checkpoint)
  const [metadataType, metadataBytes] = await store.serde.dumpsTyped({
    source: 'loop',
    step: 0,
    parents: {}
  })
  const directory = join(
    stateRoot,
    'projects',
    execution.projectId,
    'threads',
    execution.threadId,
    'branches',
    execution.branchId,
    'checkpoints',
    '_'
  )
  await mkdir(directory, { recursive: true })
  const path = join(directory, `${options.checkpointId}.json`)
  await writeFile(
    path,
    JSON.stringify({
      ...LEGACY_CHECKPOINT_COMPATIBILITY,
      checkpointVersion: checkpoint.v,
      checkpointNs: '',
      checkpointId: checkpoint.id,
      ...(options.parentCheckpointId === undefined
        ? {}
        : { parentCheckpointId: options.parentCheckpointId }),
      ...(options.externalContentIds === undefined
        ? {}
        : { externalContentIds: [...options.externalContentIds] }),
      checkpointSerde: {
        type: checkpointType,
        payload: Buffer.from(checkpointBytes).toString('base64')
      },
      metadataSerde: {
        type: metadataType,
        payload: Buffer.from(metadataBytes).toString('base64')
      },
      inputDigest: generationInputDigest(stored),
      operationId: options.operationId ?? execution.operationId
    }),
    'utf8'
  )
  if (options.writes !== undefined && options.writes.length > 0) {
    const writesDirectory = join(directory, 'writes', options.checkpointId)
    await mkdir(writesDirectory, { recursive: true })
    for (const write of options.writes)
      await writeFile(join(writesDirectory, write.name), write.content, 'utf8')
  }
  return path
}

function threadDirectory(stateRoot: string, threadId = THREAD_ID): string {
  return join(stateRoot, 'projects', PROJECT_ID, 'threads', threadId)
}

function readerFor(
  root: string,
  stateRoot: string
): {
  readonly executions: FileSceneGenerationExecutionRepositoryImpl
  readonly reader: WebGalSceneGenerationHistoryReaderImpl
} {
  const executions = new FileSceneGenerationExecutionRepositoryImpl(root)
  return {
    executions,
    reader: new WebGalSceneGenerationHistoryReaderImpl(
      stateRoot,
      new ReadOnlyGenerationCheckpointStore(stateRoot),
      new AiProjectFileSystemImpl(root),
      executions
    )
  }
}

/** 记录目录下所有普通文件的相对路径、大小、mtime 与内容，供只读断言比较。 */
async function snapshotTree(root: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {}
  const walk = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) {
        await walk(path)
        continue
      }
      if (!entry.isFile()) continue
      const info = await stat(path)
      result[relative(root, path)] = `${info.size}:${info.mtimeMs}:${(
        await readFile(path)
      ).toString('base64')}`
    }
  }
  await walk(root)
  return result
}

describe('旧检查点只读历史', () => {
  it('真实临时检查点可被列出和读取，清空记忆只删除线程状态', async () => {
    const root = await mkdtemp(join(tmpdir(), 'legacy-history-'))
    roots.push(root)
    const stateRoot = join(root, 'ai')
    await mkdir(join(root, 'official-project'), { recursive: true })
    const execution = executionFor(root)
    const { executions, reader } = readerFor(root, stateRoot)
    await executions.createExecution(execution)
    const store = new ReadOnlyGenerationCheckpointStore(stateRoot)
    const checkpointPath = await writeCheckpoint(store, stateRoot, execution, {
      checkpointId: CHECKPOINT_ID
    })
    const scope = {
      projectId: execution.projectId,
      sceneId: execution.sceneId,
      threadId: execution.threadId,
      branchId: execution.branchId
    }

    const history = await reader.listHistory({ ...scope, limit: 10 })
    expect(history.checkpoints).toHaveLength(1)
    expect(history.checkpoints[0]).toMatchObject({
      checkpointId: CHECKPOINT_ID,
      canView: true,
      canContinue: true,
      canFork: false
    })

    const checkpoint = await readWebGalGenerationCheckpoint(
      store,
      stateRoot,
      new AiProjectFileSystemImpl(root),
      { ...scope, checkpointId: CHECKPOINT_ID }
    )
    expect(checkpoint.execution.operationId).toBe(execution.operationId)
    expect(checkpoint.summary).toBe('历史摘要')

    await executions.writeExecution({ ...execution, state: 'succeeded' })
    const memory = new SceneGenerationMemoryGatewayImpl(stateRoot, executions)
    await memory.clearMemory({
      projectId: execution.projectId,
      sceneId: execution.sceneId,
      threadId: execution.threadId
    })
    await expect(access(checkpointPath)).rejects.toThrow()
  })

  it('历史读取不写盘，也不修改正式工程', async () => {
    const root = await mkdtemp(join(tmpdir(), 'legacy-history-readonly-'))
    roots.push(root)
    const stateRoot = join(root, 'ai')
    const projectRoot = join(root, 'official-project')
    await mkdir(projectRoot, { recursive: true })
    const projectFile = join(projectRoot, 'scene.txt')
    await writeFile(projectFile, 'official', 'utf8')
    const execution = executionFor(root)
    const { executions, reader } = readerFor(root, stateRoot)
    await executions.createExecution(execution)
    const store = new ReadOnlyGenerationCheckpointStore(stateRoot)
    await writeCheckpoint(store, stateRoot, execution, { checkpointId: CHECKPOINT_ID })
    // 首次读取会按既有迁移规则把当前记录补成完整文档并归档原字节；此后读取必须零写盘。
    await reader.listHistory({
      projectId: execution.projectId,
      sceneId: execution.sceneId,
      threadId: execution.threadId,
      branchId: execution.branchId,
      limit: 10
    })
    const before = await snapshotTree(root)

    const history = await reader.listHistory({
      projectId: execution.projectId,
      sceneId: execution.sceneId,
      threadId: execution.threadId,
      branchId: execution.branchId,
      limit: 10
    })
    expect(history.checkpoints).toHaveLength(1)
    const checkpoint = await reader.readCheckpoint({
      projectId: execution.projectId,
      sceneId: execution.sceneId,
      threadId: execution.threadId,
      branchId: execution.branchId,
      checkpointId: CHECKPOINT_ID
    })
    expect(checkpoint.execution.operationId).toBe(execution.operationId)

    expect(await snapshotTree(root)).toEqual(before)
    expect(await readFile(projectFile, 'utf8')).toBe('official')
  })

  it('清理保留其他分支引用的检查点、共享外置内容和其他线程', async () => {
    const root = await mkdtemp(join(tmpdir(), 'legacy-history-cleanup-'))
    roots.push(root)
    const stateRoot = join(root, 'ai')
    const projectRoot = join(root, 'official-project')
    await mkdir(projectRoot, { recursive: true })
    const projectFile = join(projectRoot, 'scene.txt')
    await writeFile(projectFile, 'official', 'utf8')
    const store = new ReadOnlyGenerationCheckpointStore(stateRoot)
    const branchA = executionFor(root)
    const branchB = executionFor(root, {
      branchId: 'branch-b',
      operationId: 'operation-b'
    })
    const otherThread = executionFor(root, {
      threadId: 'thread-b',
      branchId: 'branch-c',
      operationId: 'operation-c'
    })
    const keptAPath = await writeCheckpoint(store, stateRoot, branchA, {
      checkpointId: 'kept-a',
      externalContentIds: ['shared-content'],
      operationId: branchA.operationId
    })
    const disposablePath = await writeCheckpoint(store, stateRoot, branchA, {
      checkpointId: 'disposable',
      operationId: branchA.operationId,
      writes: [{ name: 'gone.txt', content: 'gone' }]
    })
    const keptBPath = await writeCheckpoint(store, stateRoot, branchB, {
      checkpointId: 'kept-b',
      parentCheckpointId: 'kept-a',
      externalContentIds: ['shared-content'],
      operationId: branchB.operationId
    })
    const otherPath = await writeCheckpoint(store, stateRoot, otherThread, {
      checkpointId: 'other',
      operationId: otherThread.operationId
    })
    const context = join(threadDirectory(stateRoot), 'context')
    await mkdir(context, { recursive: true })
    await writeFile(join(context, 'shared-content'), 'shared', 'utf8')
    await writeFile(join(context, 'orphan-content'), 'orphan', 'utf8')

    const result = await cleanupWorkflowState({
      stateRoot,
      projectId: branchA.projectId,
      threadId: branchA.threadId,
      branchIds: [branchA.branchId],
      projectRoot
    })

    expect(result.removed.some((path) => path.endsWith('kept-a.json'))).toBe(false)
    expect(result.removed.some((path) => path.endsWith('shared-content'))).toBe(false)
    expect(result.removed.some((path) => path.endsWith('kept-b.json'))).toBe(false)
    expect(result.removed.some((path) => path.endsWith('other.json'))).toBe(false)
    expect(result.removed.some((path) => path.endsWith('disposable.json'))).toBe(true)
    expect(result.removed.some((path) => path.endsWith(join('writes', 'disposable')))).toBe(true)
    expect(result.removed.some((path) => path.endsWith('orphan-content'))).toBe(true)
    await access(keptAPath)
    await access(keptBPath)
    await access(otherPath)
    await access(join(context, 'shared-content'))
    await expect(access(disposablePath)).rejects.toThrow()
    await expect(access(join(context, 'orphan-content'))).rejects.toThrow()
    expect(await readFile(projectFile, 'utf8')).toBe('official')
  })

  it('运行中、等待人工或待恢复操作不会被清理', async () => {
    const root = await mkdtemp(join(tmpdir(), 'legacy-history-phases-'))
    roots.push(root)
    for (const phase of ['running', 'waiting', 'pendingRecovery'] as const) {
      const stateRoot = join(root, phase)
      const identity = {
        projectId: PROJECT_ID,
        threadId: THREAD_ID,
        branchId: BRANCH_ID,
        operationId: `operation-${phase}`
      }
      await recordOperationPhase(stateRoot, identity, phase)
      const context = join(threadDirectory(stateRoot), 'context')
      await mkdir(context, { recursive: true })
      await writeFile(join(context, 'orphan-content'), 'orphan', 'utf8')

      await expect(
        cleanupWorkflowState({
          stateRoot,
          projectId: PROJECT_ID,
          threadId: THREAD_ID,
          branchIds: [BRANCH_ID]
        })
      ).rejects.toMatchObject({ code: ErrorCodes.operationConflict })
      expect(await readFile(join(context, 'orphan-content'), 'utf8')).toBe('orphan')
    }
  })

  it('清理失败时保留原始错误和已完成的结果', async () => {
    const root = await mkdtemp(join(tmpdir(), 'legacy-history-cleanup-failure-'))
    roots.push(root)
    const stateRoot = join(root, 'ai')
    const context = join(threadDirectory(stateRoot), 'context')
    await mkdir(context, { recursive: true })
    await writeFile(join(context, 'orphan-one'), 'one', 'utf8')
    await writeFile(join(context, 'orphan-two'), 'two', 'utf8')
    const diskError = new Error('disk-failed')
    let calls = 0

    const error = await cleanupWorkflowState({
      stateRoot,
      projectId: PROJECT_ID,
      threadId: THREAD_ID,
      branchIds: [BRANCH_ID],
      removeFile: async (path) => {
        calls += 1
        if (calls === 2) throw diskError
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
    expect(await readdir(context)).toHaveLength(1)
  })

  it('不清理候选 Git 修订库，并保留完整祖先链和删除待写入', async () => {
    const root = await mkdtemp(join(tmpdir(), 'legacy-history-ancestors-'))
    roots.push(root)
    const stateRoot = join(root, 'ai')
    const store = new ReadOnlyGenerationCheckpointStore(stateRoot)
    const branchA = executionFor(root)
    const branchB = executionFor(root, {
      branchId: 'branch-b',
      operationId: 'operation-b'
    })
    const rootPath = await writeCheckpoint(store, stateRoot, branchA, {
      checkpointId: 'root'
    })
    const middlePath = await writeCheckpoint(store, stateRoot, branchA, {
      checkpointId: 'middle',
      parentCheckpointId: 'root'
    })
    const disposablePath = await writeCheckpoint(store, stateRoot, branchA, {
      checkpointId: 'disposable',
      writes: [{ name: 'gone.txt', content: 'gone' }]
    })
    await writeCheckpoint(store, stateRoot, branchB, {
      checkpointId: 'kept-b',
      parentCheckpointId: 'middle',
      operationId: branchB.operationId
    })
    const revisions = join(threadDirectory(stateRoot), 'revisions')
    await mkdir(join(revisions, 'objects'), { recursive: true })
    await writeFile(join(revisions, 'HEAD'), 'ref: refs/heads/revisions\n', 'utf8')
    await writeFile(join(revisions, 'objects', 'pack'), 'git-object', 'utf8')

    await cleanupWorkflowState({
      stateRoot,
      projectId: branchA.projectId,
      threadId: branchA.threadId,
      branchIds: [branchA.branchId]
    })

    await access(rootPath)
    await access(middlePath)
    await expect(access(disposablePath)).rejects.toThrow()
    await expect(
      access(join(threadDirectory(stateRoot), 'branches', BRANCH_ID, 'checkpoints', '_', 'writes', 'disposable'))
    ).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readFile(join(revisions, 'HEAD'), 'utf8')).toContain('refs/heads/revisions')
    expect(await readFile(join(revisions, 'objects', 'pack'), 'utf8')).toBe('git-object')
  })

  it('线程目录内的联接不能把清理带到其他线程', async () => {
    const root = await mkdtemp(join(tmpdir(), 'legacy-history-symlink-'))
    roots.push(root)
    const stateRoot = join(root, 'ai')
    const otherContext = join(threadDirectory(stateRoot, 'thread-b'), 'context')
    const thisContext = join(threadDirectory(stateRoot), 'context')
    await mkdir(otherContext, { recursive: true })
    await mkdir(threadDirectory(stateRoot), { recursive: true })
    await writeFile(join(otherContext, 'other-content'), 'keep', 'utf8')
    await symlink(otherContext, thisContext, 'junction')

    await expect(
      cleanupWorkflowState({
        stateRoot,
        projectId: PROJECT_ID,
        threadId: THREAD_ID,
        branchIds: [BRANCH_ID]
      })
    ).rejects.toMatchObject({ code: ErrorCodes.forbidden })
    expect(await readFile(join(otherContext, 'other-content'), 'utf8')).toBe('keep')
  })
})
