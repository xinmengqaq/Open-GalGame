import { readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { createRequire } from 'node:module'

import {
  emptyCheckpoint,
  type CheckpointMetadata,
  type SerializerProtocol
} from '@langchain/langgraph-checkpoint'

import { ErrorCodes } from '@common/errors/ErrorCodes'
import { FileCheckpointSaver } from '@infrastructure/workflow/checkpoints/FileCheckpointSaver'
import { langGraphThreadKey } from '@infrastructure/workflow/WorkflowIdentity'
import { WorkflowError } from '@infrastructure/workflow/WorkflowError'
import { classifyWorkflowError } from '@infrastructure/workflow/execution/workflowErrors'

import {
  compileCounter,
  identity,
  removeTemporaryDirectories,
  temporaryDirectory
} from './workflowFixture'

const metadata = { source: 'loop', step: 0, parents: {} } satisfies CheckpointMetadata

afterEach(async () => {
  await removeTemporaryDirectories()
})

describe('文件检查点存储', () => {
  it('损坏的待写入 JSON 在磁盘读取边界转换为检查点损坏并保留原因', async () => {
    const root = await temporaryDirectory()
    const saver = new FileCheckpointSaver(root)
    const checkpoint = emptyCheckpoint()
    const key = langGraphThreadKey(identity())
    const config = { configurable: { thread_id: key, checkpoint_id: checkpoint.id } }
    await saver.put({ configurable: { thread_id: key } }, checkpoint, metadata, {})
    await saver.putWrites(config, [['value', 'pending']], 'task-1')
    const names = await readdir(root, { recursive: true })
    const write = names.find(
      (name) => name.replaceAll('\\', '/').includes('/writes/') && name.endsWith('.json')
    )
    if (!write) throw new Error('missing pending write')
    await writeFile(join(root, write), '{invalid-json', 'utf8')
    const error = await saver.getTuple(config).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(WorkflowError)
    expect(classifyWorkflowError(error)).toMatchObject({
      category: 'checkpointCorrupt',
      cause: expect.any(Error)
    })
  })

  it('原子写入并读回完整状态、父检查点和待完成写入', async () => {
    const root = await temporaryDirectory()
    const saver = new FileCheckpointSaver(root)
    const key = langGraphThreadKey(identity())
    const parent = emptyCheckpoint()
    parent.channel_values = { value: 'parent', items: new Set(['a']), note: undefined }
    const child = emptyCheckpoint()
    child.channel_values = { value: 'child' }

    await saver.put({ configurable: { thread_id: key } }, parent, metadata, {})
    await saver.putWrites(
      { configurable: { thread_id: key, checkpoint_id: parent.id, checkpoint_ns: '' } },
      [['value', 'pending']],
      'task-1'
    )
    await saver.put(
      { configurable: { thread_id: key, checkpoint_id: parent.id, checkpoint_ns: '' } },
      child,
      { ...metadata, step: 1 },
      {}
    )

    const reloaded = new FileCheckpointSaver(root)
    const loaded = await reloaded.getTuple({
      configurable: { thread_id: key, checkpoint_id: child.id, checkpoint_ns: '' }
    })
    const parentLoaded = await reloaded.getTuple({
      configurable: { thread_id: key, checkpoint_id: parent.id, checkpoint_ns: '' }
    })

    expect(loaded?.checkpoint.channel_values.value).toBe('child')
    expect(loaded?.parentConfig?.configurable?.checkpoint_id).toBe(parent.id)
    expect(parentLoaded?.checkpoint.channel_values.items).toEqual(new Set(['a']))
    expect(parentLoaded?.checkpoint.channel_values.note).toBeUndefined()
    expect(parentLoaded?.pendingWrites).toEqual([['task-1', 'value', 'pending']])
    expect(await temporaryNames(root)).not.toContain(expect.stringContaining('.opengalgame-tmp-'))
    const require = createRequire(import.meta.url)
    const installed = require('@langchain/langgraph/package.json') as { version: string }
    expect(
      JSON.parse(await readFile(await findCheckpointFile(root, child.id), 'utf8')).langgraph
    ).toBe(installed.version)
  })

  it('损坏、缺字段、非法路径和版本不兼容分别失败', async () => {
    const root = await temporaryDirectory()
    const saver = new FileCheckpointSaver(root)
    const key = langGraphThreadKey(identity())
    const checkpoint = emptyCheckpoint()
    checkpoint.channel_values = { value: 'kept' }
    await saver.put({ configurable: { thread_id: key } }, checkpoint, metadata, {})
    const file = await findCheckpointFile(root, checkpoint.id)
    const original = await readFile(file, 'utf8')

    await writeFile(file, '{"broken"', 'utf8')
    await expect(
      saver.getTuple({ configurable: { thread_id: key, checkpoint_id: checkpoint.id } })
    ).rejects.toMatchObject({ category: 'checkpointCorrupt' })

    const parsed = JSON.parse(original) as { checkpointSerde?: unknown; langgraph?: string }
    delete parsed.checkpointSerde
    await writeFile(file, JSON.stringify(parsed), 'utf8')
    await expect(
      saver.getTuple({ configurable: { thread_id: key, checkpoint_id: checkpoint.id } })
    ).rejects.toMatchObject({ category: 'checkpointCorrupt' })

    parsed.checkpointSerde = JSON.parse(original).checkpointSerde
    parsed.langgraph = '9.9.9'
    await writeFile(file, JSON.stringify(parsed), 'utf8')
    const incompatible = await saver
      .getTuple({ configurable: { thread_id: key, checkpoint_id: checkpoint.id } })
      .then(() => undefined)
      .catch((error: unknown) => error)
    expect(incompatible).toBeInstanceOf(WorkflowError)
    expect(incompatible).toMatchObject({ category: 'checkpointIncompatible' })
    expect((incompatible as WorkflowError).category).not.toBe('checkpointCorrupt')

    await expect(
      saver.getTuple({ configurable: { thread_id: key, checkpoint_id: '../outside' } })
    ).rejects.toMatchObject({ code: ErrorCodes.invalidRequest })
    await expect(stat(join(root, '..', 'outside.json'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('不同项目、线程和分支不能读取彼此的检查点', async () => {
    const root = await temporaryDirectory()
    const saver = new FileCheckpointSaver(root)
    const first = identity()
    const otherProject = identity({ projectId: 'project-b' })
    const otherThread = identity({ threadId: 'thread-b' })
    const otherBranch = identity({ branchId: 'branch-b' })
    const checkpoint = emptyCheckpoint()
    checkpoint.channel_values = { value: 'isolated' }
    await saver.put(
      { configurable: { thread_id: langGraphThreadKey(first) } },
      checkpoint,
      metadata,
      {}
    )

    await expect(
      saver.getTuple({
        configurable: { thread_id: langGraphThreadKey(otherProject), checkpoint_id: checkpoint.id }
      })
    ).resolves.toBeUndefined()
    await expect(
      saver.getTuple({
        configurable: { thread_id: langGraphThreadKey(otherThread), checkpoint_id: checkpoint.id }
      })
    ).resolves.toBeUndefined()
    await expect(
      saver.getTuple({
        configurable: { thread_id: langGraphThreadKey(otherBranch), checkpoint_id: checkpoint.id }
      })
    ).resolves.toBeUndefined()
    const listed = []
    for await (const item of saver.list({
      configurable: { thread_id: langGraphThreadKey(otherBranch) }
    })) {
      listed.push(item.checkpoint.id)
    }
    expect(listed).toEqual([])
  })

  it('不把密钥写入检查点，真实图可以恢复父检查点关系', async () => {
    const root = await temporaryDirectory()
    const saver = new FileCheckpointSaver(root)
    const secret = 'sk-test-secret-value'
    const checkpoint = emptyCheckpoint()
    checkpoint.channel_values = { value: 'story' }
    await saver.put(
      { configurable: { thread_id: langGraphThreadKey(identity()), apiKey: secret } },
      checkpoint,
      { ...metadata, apiKey: secret } as CheckpointMetadata,
      {}
    )
    const file = await findCheckpointFile(root, checkpoint.id)
    expect(await readFile(file, 'utf8')).not.toContain(secret)

    const graph = compileCounter(saver)
    const config = {
      configurable: { thread_id: langGraphThreadKey(identity({ operationId: 'operation-b' })) }
    }
    await graph.invoke({ value: '' }, config)
    const again = compileCounter(new FileCheckpointSaver(root))
    const history = []
    for await (const snapshot of again.getStateHistory(config)) history.push(snapshot)
    expect(history.length).toBeGreaterThan(1)
    expect(history[0]?.parentConfig?.configurable?.checkpoint_id).toBe(
      history[1]?.config.configurable?.checkpoint_id
    )
    expect(history.some((snapshot) => snapshot.values.value === 'one-two')).toBe(true)
  })

  it('同一任务的十二项写入按数值序号恢复', async () => {
    const root = await temporaryDirectory()
    const saver = new FileCheckpointSaver(root)
    const key = langGraphThreadKey(identity())
    const checkpoint = emptyCheckpoint()
    await saver.put({ configurable: { thread_id: key } }, checkpoint, metadata, {})
    await saver.putWrites(
      { configurable: { thread_id: key, checkpoint_id: checkpoint.id, checkpoint_ns: '' } },
      Array.from({ length: 12 }, (_, index) => ['channel', index]),
      'task-1'
    )

    const loaded = await saver.getTuple({
      configurable: { thread_id: key, checkpoint_id: checkpoint.id }
    })
    expect(loaded?.pendingWrites?.map((item) => item[2])).toEqual([
      0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11
    ])
  })

  it('自定义序列化类型可以读回，缺失恢复字段算损坏', async () => {
    const root = await temporaryDirectory()
    const saver = new FileCheckpointSaver(root, new MarkSerializer())
    const key = langGraphThreadKey(identity())
    const checkpoint = emptyCheckpoint()
    checkpoint.channel_values = { value: 'marked' }
    await saver.put({ configurable: { thread_id: key } }, checkpoint, metadata, {})
    const loaded = await saver.getTuple({
      configurable: { thread_id: key, checkpoint_id: checkpoint.id }
    })
    expect(loaded?.checkpoint.channel_values.value).toBe('marked')

    const file = await findCheckpointFile(root, checkpoint.id)
    const envelope = JSON.parse(await readFile(file, 'utf8')) as {
      checkpointSerde: { payload: string }
    }
    const decoded = JSON.parse(
      Buffer.from(envelope.checkpointSerde.payload, 'base64').toString('utf8')
    )
    delete decoded.channel_values
    envelope.checkpointSerde.payload = Buffer.from(JSON.stringify(decoded)).toString('base64')
    await writeFile(file, JSON.stringify(envelope), 'utf8')
    await expect(
      saver.getTuple({ configurable: { thread_id: key, checkpoint_id: checkpoint.id } })
    ).rejects.toMatchObject({ category: 'checkpointCorrupt' })
  })
})

class MarkSerializer implements SerializerProtocol {
  async dumpsTyped(data: unknown): Promise<[string, Uint8Array]> {
    return ['mark', new TextEncoder().encode(JSON.stringify(data))]
  }

  async loadsTyped(type: string, data: Uint8Array | string): Promise<unknown> {
    if (type !== 'mark') throw new Error(`Unknown serialization type: ${type}`)
    const text = typeof data === 'string' ? data : new TextDecoder().decode(data)
    return JSON.parse(text)
  }
}

async function findCheckpointFile(root: string, checkpointId: string): Promise<string> {
  const found = (await walk(root)).find((path) => path.endsWith(`${checkpointId}.json`))
  if (!found) throw new Error(`missing checkpoint ${checkpointId}`)
  return found
}

async function temporaryNames(root: string): Promise<string[]> {
  return walk(root)
}

async function walk(directory: string): Promise<string[]> {
  let names: string[]
  try {
    names = await readdir(directory)
  } catch {
    return []
  }
  const paths: string[] = []
  for (const name of names) {
    const path = join(directory, name)
    paths.push(path)
    paths.push(...(await walk(path)))
  }
  return paths
}
