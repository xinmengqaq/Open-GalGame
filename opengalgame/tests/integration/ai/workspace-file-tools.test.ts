import { mkdtemp, mkdir, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

const fsMock = vi.hoisted(() => ({
  readFile: vi.fn(),
  open: vi.fn(),
  rm: vi.fn()
}))

vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
  fsMock.readFile.mockImplementation((...args: Parameters<typeof actual.readFile>) =>
    actual.readFile(...args)
  )
  fsMock.open.mockImplementation((...args: Parameters<typeof actual.open>) => actual.open(...args))
  fsMock.rm.mockImplementation((...args: Parameters<typeof actual.rm>) => actual.rm(...args))
  return { ...actual, readFile: fsMock.readFile, open: fsMock.open, rm: fsMock.rm }
})

import { HumanMessage } from '@langchain/core/messages'
import { createAgent, FakeToolCallingModel } from 'langchain'

import { createWorkspaceFileTools } from '@infrastructure/ai/tools/WorkspaceFileTools'
import { ExecutionBudget } from '@infrastructure/ai/execution/ExecutionBudget'
import { executionScope, type ExecutionScope } from '@infrastructure/ai/execution/executionScope'
import type { AgentRunContext } from '@infrastructure/ai/agents/AgentExecution'

const roots: string[] = []
let actualFs: typeof import('node:fs/promises')

beforeAll(async () => {
  actualFs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
})

afterEach(async () => {
  fsMock.readFile.mockImplementation((...args: Parameters<typeof actualFs.readFile>) =>
    actualFs.readFile(...args)
  )
  fsMock.open.mockImplementation((...args: Parameters<typeof actualFs.open>) =>
    actualFs.open(...args)
  )
  fsMock.rm.mockImplementation((...args: Parameters<typeof actualFs.rm>) => actualFs.rm(...args))
  vi.useRealTimers()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('工作区文件工具', () => {
  it('列目录、范围读取、写入和精确替换会修改临时目录中的文件', async () => {
    const root = await createRoot()
    await writeFile(join(root, 'note.txt'), '你好世界')
    await mkdir(join(root, 'scene'))
    const [listDirectory, readTextRange, writeText, replaceText] = createWorkspaceFileTools()
    const context = runContext(root, true)

    const listing = await listDirectory.invoke({ path: '' }, { context })
    expect(listing).toMatchObject({
      path: '',
      entries: expect.arrayContaining([
        { name: 'note.txt', kind: 'file' },
        { name: 'scene', kind: 'directory' }
      ])
    })
    await expect(
      readTextRange.invoke({ path: 'note.txt', start: 1, maxChars: 2 }, { context })
    ).resolves.toMatchObject({
      content: '好世',
      complete: false,
      truncated: true
    })
    await writeText.invoke({ path: 'scene/a.txt', content: 'alpha' }, { context })
    expect(await readFile(join(root, 'scene', 'a.txt'), 'utf8')).toBe('alpha')
    await replaceText.invoke(
      { path: 'scene/a.txt', oldText: 'alpha', newText: 'beta', expectedMatches: 1 },
      { context }
    )
    expect(await readFile(join(root, 'scene', 'a.txt'), 'utf8')).toBe('beta')
  })

  it('越权路径和链接逃逸失败，区外文件不被读取或改写', async (ctx) => {
    const root = await createRoot()
    const outside = await createRoot()
    const secret = join(outside, 'secret.txt')
    await writeFile(secret, 'secret')
    await writeFile(join(root, 'inside.txt'), 'inside')
    const [, readTextRange, writeText] = createWorkspaceFileTools()
    const context = runContext(root, true)

    await expect(
      readTextRange.invoke({ path: '../secret.txt', start: 0, maxChars: 10 }, { context })
    ).rejects.toThrow('路径超出允许范围')
    await expect(
      writeText.invoke({ path: 'C:/outside.txt', content: 'no' }, { context })
    ).rejects.toThrow('路径超出允许范围')
    expect(await readFile(secret, 'utf8')).toBe('secret')
    try {
      await symlink(secret, join(root, 'escape.txt'), 'file')
    } catch {
      ctx.skip()
      return
    }
    await expect(
      readTextRange.invoke({ path: 'escape.txt', start: 0, maxChars: 10 }, { context })
    ).rejects.toThrow('路径超出允许范围')
    expect(await readFile(secret, 'utf8')).toBe('secret')
    expect(await readFile(join(root, 'inside.txt'), 'utf8')).toBe('inside')
  })

  it('大文件按范围读取并标明截断，不先整体读入', async () => {
    const root = await createRoot()
    await writeFile(join(root, 'large.txt'), `头${'中'.repeat(200000)}尾`)
    fsMock.readFile.mockClear()
    const [, readTextRange] = createWorkspaceFileTools()

    const result = await readTextRange.invoke(
      { path: 'large.txt', start: 0, maxChars: 2 },
      { context: runContext(root, false) }
    )

    expect(result).toMatchObject({
      content: '头中',
      complete: false,
      truncated: true,
      start: 0,
      end: 2
    })
    expect(fsMock.readFile).not.toHaveBeenCalled()
  })

  it('真实 Agent 调用时工具从原生运行上下文取得工作区', async () => {
    const root = await createRoot()
    await mkdir(join(root, 'scene'))
    const agent = createAgent({
      model: new FakeToolCallingModel({
        toolCalls: [
          [
            {
              name: 'writeText',
              args: { path: 'scene/note.txt', content: '来自工具' },
              id: 'call_1'
            }
          ],
          []
        ]
      }),
      tools: createWorkspaceFileTools(),
      name: 'workspace-tools-agent'
    })

    await agent.invoke(
      { messages: [new HumanMessage('写入')] },
      { context: runContext(root, true) }
    )

    expect(await readFile(join(root, 'scene', 'note.txt'), 'utf8')).toBe('来自工具')
  })

  it('工具授权只来自原生运行上下文，进程内作用域不能替代', async () => {
    const root = await createRoot()
    const [, , writeText] = createWorkspaceFileTools()

    await expect(
      executionScope.run(scopeWithContext(root), async () =>
        writeText.invoke({ path: 'keep.txt', content: 'new' }, { context: {} })
      )
    ).rejects.toThrow('本次执行没有授权工作区')
    await expect(readFile(join(root, 'keep.txt'), 'utf8')).rejects.toThrow()
  })

  it('替换次数不符不改文件，同一文件的并发修改不会静默丢失', async () => {
    const root = await createRoot()
    await writeFile(join(root, 'edit.txt'), 'alpha')
    const [, , , replaceText] = createWorkspaceFileTools()
    const context = runContext(root, true)

    await expect(
      replaceText.invoke(
        { path: 'edit.txt', oldText: 'alpha', newText: 'nope', expectedMatches: 2 },
        { context }
      )
    ).rejects.toThrow('替换次数与预期不一致，文件未修改')
    expect(await readFile(join(root, 'edit.txt'), 'utf8')).toBe('alpha')

    const results = await Promise.allSettled([
      replaceText.invoke(
        { path: 'edit.txt', oldText: 'alpha', newText: 'one', expectedMatches: 1 },
        { context }
      ),
      replaceText.invoke(
        { path: 'edit.txt', oldText: 'alpha', newText: 'two', expectedMatches: 1 },
        { context }
      )
    ])
    const fulfilled = results.filter((result) => result.status === 'fulfilled')
    expect(fulfilled).toHaveLength(1)
    expect(['one', 'two']).toContain(await readFile(join(root, 'edit.txt'), 'utf8'))
  })

  it('取消时保留原文件，缺少工作区或只读授权会失败', async () => {
    const root = await createRoot()
    await writeFile(join(root, 'keep.txt'), 'old')
    const [, , writeText] = createWorkspaceFileTools()
    const controller = new AbortController()
    controller.abort()

    await expect(
      writeText.invoke(
        { path: 'keep.txt', content: 'new' },
        { context: runContext(root, true), signal: controller.signal }
      )
    ).rejects.toThrow('执行已取消')
    expect(await readFile(join(root, 'keep.txt'), 'utf8')).toBe('old')
    await expect(
      writeText.invoke({ path: 'keep.txt', content: 'new' }, { context: runContext(root, false) })
    ).rejects.toThrow('当前工作区不允许写入')
    await expect(writeText.invoke({ path: 'keep.txt', content: 'new' }, {})).rejects.toThrow(
      '本次执行没有授权工作区'
    )
  })

  it('回读期间取消则保留原文件并清理临时文件', async () => {
    const root = await createRoot()
    const target = join(root, 'keep.txt')
    await writeFile(target, 'old')
    const [, , writeText] = createWorkspaceFileTools()
    const controller = new AbortController()
    fsMock.readFile.mockImplementation(async (...args: Parameters<typeof actualFs.readFile>) => {
      const path = String(args[0])
      if (path.includes('.opengalgame-tmp-')) {
        controller.abort()
        return Buffer.from('new')
      }
      return actualFs.readFile(...args)
    })

    await expect(
      writeText.invoke(
        { path: 'keep.txt', content: 'new' },
        { context: runContext(root, true), signal: controller.signal }
      )
    ).rejects.toThrow(/执行已取消|aborted/i)
    expect(await readFile(target, 'utf8')).toBe('old')
    await expect
      .poll(async () => (await readdir(root)).some((name) => name.startsWith('.opengalgame-tmp-')))
      .toBe(false)
  })

  it('非法 UTF-8 不按替换字符改写原字节', async () => {
    const root = await createRoot()
    const target = join(root, 'binary.txt')
    const original = Buffer.from([0xff, 0x61])
    await writeFile(target, original)
    const [, , , replaceText] = createWorkspaceFileTools()

    await expect(
      replaceText.invoke(
        { path: 'binary.txt', oldText: 'a', newText: 'b', expectedMatches: 1 },
        { context: runContext(root, true) }
      )
    ).rejects.toThrow('文件不是合法的 UTF-8')
    expect(await readFile(target)).toEqual(original)
  })

  it('写入失败且临时文件无法清理时同时保留两个原因', async () => {
    const root = await createRoot()
    const [, , writeText] = createWorkspaceFileTools()
    fsMock.open.mockRejectedValueOnce(Object.assign(new Error('disk'), { code: 'ENOSPC' }))
    fsMock.rm.mockRejectedValueOnce(Object.assign(new Error('busy'), { code: 'EBUSY' }))

    await expect(
      writeText.invoke({ path: 'broken.txt', content: 'x' }, { context: runContext(root, true) })
    ).rejects.toMatchObject({ message: '文件写入失败，临时文件或句柄未能清理' })
  })
})

/** 构造一份带授权的执行作用域，用于确认工具不从这里补取工作区。 */
function scopeWithContext(root: string): ExecutionScope {
  return {
    context: runContext(root, true),
    requestTimeoutMs: 60000,
    toolTimeoutMs: 60000,
    toolResultCharLimit: 1000,
    summaryOutcome: 'idle'
  }
}

function runContext(root: string, writable: boolean): AgentRunContext {
  return {
    budget: new ExecutionBudget({ modelAttempts: 4, toolCalls: 4, activeMs: 60000 }),
    workspace: { root, writable }
  }
}

async function createRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'workspace-'))
  roots.push(root)
  return root
}
