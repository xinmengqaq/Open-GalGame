import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'

import { recoverLegacyUserDirectory } from '@bootstrap/devUserDirectoryRecovery'
import { ErrorCodes } from '@common/errors/ErrorCodes'

const directories: string[] = []

afterEach(async () => {
  for (const directory of directories.splice(0)) {
    await rm(directory, { recursive: true, force: true })
  }
})

async function parent(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'opengalgame-recovery-'))
  directories.push(directory)
  return directory
}

async function writeProjects(
  directory: string,
  registrations: readonly { id: string; directory: string; operationId: string }[]
): Promise<void> {
  await mkdir(directory, { recursive: true })
  await writeFile(
    join(directory, 'projects.json'),
    `${JSON.stringify({ registrations }, null, 2)}\n`
  )
}

async function readProjects(
  directory: string
): Promise<{ id: string; directory: string; operationId: string }[]> {
  const document = JSON.parse(await readFile(join(directory, 'projects.json'), 'utf8')) as {
    registrations: { id: string; directory: string; operationId: string }[]
  }
  return document.registrations
}

it('非空规范目录补回旧目录基线，已有登记保持不变', async () => {
  const root = await parent()
  const canonical = join(root, '.opengalgame')
  const legacy = join(root, '.opengalgame ')
  await writeProjects(canonical, [
    { id: 'desktop-1', directory: join(root, 'desktop-1'), operationId: 'op-desktop-1' },
    { id: 'desktop-2', directory: join(root, 'desktop-2'), operationId: 'op-desktop-2' }
  ])
  await writeProjects(legacy, [
    { id: 'baseline', directory: join(root, 'baseline'), operationId: 'op-baseline' }
  ])

  const result = await recoverLegacyUserDirectory(canonical)

  expect(result).toMatchObject({ recovered: 1, sources: 1 })
  expect(await readProjects(canonical)).toEqual([
    { id: 'desktop-1', directory: join(root, 'desktop-1'), operationId: 'op-desktop-1' },
    { id: 'desktop-2', directory: join(root, 'desktop-2'), operationId: 'op-desktop-2' },
    { id: 'baseline', directory: join(root, 'baseline'), operationId: 'op-baseline' }
  ])
})

it('已记录来源第二次启动不再合并', async () => {
  const root = await parent()
  const canonical = join(root, '.opengalgame')
  const legacy = join(root, '.opengalgame ')
  await writeProjects(canonical, [
    { id: 'desktop-1', directory: join(root, 'desktop-1'), operationId: 'op-desktop-1' }
  ])
  await writeProjects(legacy, [
    { id: 'baseline', directory: join(root, 'baseline'), operationId: 'op-baseline' }
  ])

  await recoverLegacyUserDirectory(canonical)
  const again = await recoverLegacyUserDirectory(canonical)

  expect(again.recovered).toBe(0)
  expect(await readProjects(canonical)).toHaveLength(2)
  expect(JSON.parse(await readFile(join(canonical, 'dev-recovery.json'), 'utf8'))).toEqual({
    version: 1,
    sources: ['.opengalgame ']
  })
})

it('用户移除恢复出的登记后不再加回', async () => {
  const root = await parent()
  const canonical = join(root, '.opengalgame')
  const legacy = join(root, '.opengalgame ')
  await writeProjects(canonical, [])
  await writeProjects(legacy, [
    { id: 'baseline', directory: join(root, 'baseline'), operationId: 'op-baseline' }
  ])
  await recoverLegacyUserDirectory(canonical)
  await writeProjects(canonical, [])

  const again = await recoverLegacyUserDirectory(canonical)

  expect(again.recovered).toBe(0)
  expect(await readProjects(canonical)).toEqual([])
})

it('规范目录不存在时从旧目录恢复一条登记', async () => {
  const root = await parent()
  const canonical = join(root, '.opengalgame')
  const legacy = join(root, '.opengalgame ')
  await writeProjects(legacy, [
    { id: 'baseline', directory: join(root, 'baseline'), operationId: 'op-baseline' }
  ])

  const result = await recoverLegacyUserDirectory(canonical)

  expect(result.recovered).toBe(1)
  expect(await readProjects(canonical)).toEqual([
    { id: 'baseline', directory: join(root, 'baseline'), operationId: 'op-baseline' }
  ])
})

it('相同身份、目录或操作标识的候选登记记为冲突并跳过', async () => {
  const root = await parent()
  const canonical = join(root, '.opengalgame')
  const legacy = join(root, '.opengalgame ')
  const sharedDirectory = join(root, 'Shared')
  await writeProjects(canonical, [
    { id: 'kept-id', directory: join(root, 'kept'), operationId: 'op-kept' },
    { id: 'other-id', directory: sharedDirectory, operationId: 'op-directory' },
    { id: 'third-id', directory: join(root, 'third'), operationId: 'op-shared' }
  ])
  await writeProjects(legacy, [
    { id: 'kept-id', directory: join(root, 'new-a'), operationId: 'op-new-a' },
    { id: 'new-b', directory: sharedDirectory.toLowerCase(), operationId: 'op-new-b' },
    { id: 'new-c', directory: join(root, 'new-c'), operationId: 'op-shared' },
    { id: 'fresh', directory: join(root, 'fresh'), operationId: 'op-fresh' }
  ])

  const result = await recoverLegacyUserDirectory(canonical)

  expect(result).toMatchObject({ recovered: 1, skippedConflicts: 3 })
  expect(await readProjects(canonical)).toEqual([
    { id: 'kept-id', directory: join(root, 'kept'), operationId: 'op-kept' },
    { id: 'other-id', directory: sharedDirectory, operationId: 'op-directory' },
    { id: 'third-id', directory: join(root, 'third'), operationId: 'op-shared' },
    { id: 'fresh', directory: join(root, 'fresh'), operationId: 'op-fresh' }
  ])
})

it('一个空格和两个空格的旧目录按名称顺序合并', async () => {
  const root = await parent()
  const canonical = join(root, '.opengalgame')
  await writeProjects(join(root, '.opengalgame  '), [
    { id: 'two-spaces', directory: join(root, 'two'), operationId: 'op-two' }
  ])
  await writeProjects(join(root, '.opengalgame '), [
    { id: 'one-space', directory: join(root, 'one'), operationId: 'op-one' }
  ])

  const result = await recoverLegacyUserDirectory(canonical)

  expect(result).toMatchObject({ recovered: 2, sources: 2 })
  expect((await readProjects(canonical)).map((item) => item.id)).toEqual([
    'one-space',
    'two-spaces'
  ])
})

it('补齐缺失的操作记录，已有同名文件保持原内容', async () => {
  const root = await parent()
  const canonical = join(root, '.opengalgame')
  const legacy = join(root, '.opengalgame ')
  await writeProjects(canonical, [])
  await writeProjects(legacy, [])
  await mkdir(join(legacy, 'operations'), { recursive: true })
  await mkdir(join(canonical, 'operations'), { recursive: true })
  await writeFile(join(legacy, 'operations', 'op-missing.json'), '{"stage":"missing"}\n')
  await writeFile(join(legacy, 'operations', 'op-kept.json'), '{"stage":"legacy"}\n')
  await writeFile(join(legacy, 'operations', 'notes.txt'), 'skip\n')
  await writeFile(join(canonical, 'operations', 'op-kept.json'), '{"stage":"canonical"}\n')

  await recoverLegacyUserDirectory(canonical)

  expect(await readFile(join(canonical, 'operations', 'op-missing.json'), 'utf8')).toBe(
    '{"stage":"missing"}\n'
  )
  expect(await readFile(join(canonical, 'operations', 'op-kept.json'), 'utf8')).toBe(
    '{"stage":"canonical"}\n'
  )
  await expect(readFile(join(canonical, 'operations', 'notes.txt'), 'utf8')).rejects.toThrow()
})

it('浏览器模型可单独复制，凭据和密钥必须成对复制', async () => {
  const root = await parent()
  const canonical = join(root, '.opengalgame')
  const legacy = join(root, '.opengalgame ')
  await writeProjects(canonical, [])
  await writeProjects(legacy, [])
  await writeFile(join(legacy, 'browser-models.json'), '{"models":["legacy"]}\n')
  const key = Buffer.alloc(32, 7)
  await writeFile(join(legacy, 'browser-credentials.json'), '{"secret":"legacy"}\n')
  await writeFile(join(legacy, 'browser-dev-key'), key)

  await recoverLegacyUserDirectory(canonical)

  expect(await readFile(join(canonical, 'browser-models.json'), 'utf8')).toBe(
    '{"models":["legacy"]}\n'
  )
  expect(await readFile(join(canonical, 'browser-credentials.json'), 'utf8')).toBe(
    '{"secret":"legacy"}\n'
  )
  expect(await readFile(join(canonical, 'browser-dev-key'))).toEqual(key)

  const partialRoot = await parent()
  const partialCanonical = join(partialRoot, '.opengalgame')
  const partialLegacy = join(partialRoot, '.opengalgame ')
  await writeProjects(partialCanonical, [])
  await writeProjects(partialLegacy, [])
  await writeFile(join(partialCanonical, 'browser-credentials.json'), '{"secret":"kept"}\n')
  await writeFile(join(partialLegacy, 'browser-credentials.json'), '{"secret":"legacy"}\n')
  await writeFile(join(partialLegacy, 'browser-dev-key'), Buffer.alloc(32, 9))

  await recoverLegacyUserDirectory(partialCanonical)

  expect(await readFile(join(partialCanonical, 'browser-credentials.json'), 'utf8')).toBe(
    '{"secret":"kept"}\n'
  )
  await expect(readFile(join(partialCanonical, 'browser-dev-key'))).rejects.toMatchObject({
    code: 'ENOENT'
  })
})

it('旧登记损坏时以 5101 失败且规范目录不变', async () => {
  const root = await parent()
  const canonical = join(root, '.opengalgame')
  const legacy = join(root, '.opengalgame ')
  await writeProjects(canonical, [
    { id: 'desktop-1', directory: join(root, 'desktop-1'), operationId: 'op-desktop-1' }
  ])
  await mkdir(legacy, { recursive: true })
  await writeFile(join(legacy, 'projects.json'), '{')
  const before = await readFile(join(canonical, 'projects.json'))

  await expect(recoverLegacyUserDirectory(canonical)).rejects.toMatchObject({
    code: ErrorCodes.invalidConfig,
    message: '用户目录恢复失败，请检查开发用户目录配置'
  })
  expect(await readFile(join(canonical, 'projects.json'))).toEqual(before)
  await expect(readFile(join(canonical, 'dev-recovery.json'))).rejects.toMatchObject({
    code: 'ENOENT'
  })
})

it('没有候选时不创建规范目录', async () => {
  const root = await parent()
  const canonical = join(root, '.opengalgame')
  await mkdir(join(root, '.opengalgame-other'), { recursive: true })
  await writeProjects(join(root, ' .opengalgame'), [])

  const result = await recoverLegacyUserDirectory(canonical)

  expect(result).toEqual({ recovered: 0, skippedConflicts: 0, sources: 0 })
  await expect(readFile(join(canonical, 'dev-recovery.json'))).rejects.toMatchObject({
    code: 'ENOENT'
  })
  await expect(readFile(join(canonical, 'projects.json'))).rejects.toMatchObject({ code: 'ENOENT' })
})

it('附属复制失败时登记已落盘且来源未标记，修好后可重试', async () => {
  const root = await parent()
  const canonical = join(root, '.opengalgame')
  const legacy = join(root, '.opengalgame ')
  const brokenName = '11111111-1111-4111-8111-111111111111.json'
  await writeProjects(canonical, [
    { id: 'desktop-1', directory: join(root, 'desktop-1'), operationId: 'op-desktop-1' }
  ])
  await writeProjects(legacy, [
    { id: 'baseline', directory: join(root, 'baseline'), operationId: 'op-baseline' }
  ])
  await mkdir(join(legacy, 'operations', brokenName), { recursive: true })

  await expect(recoverLegacyUserDirectory(canonical)).rejects.toMatchObject({
    code: ErrorCodes.invalidConfig,
    message: '用户目录恢复失败，请检查开发用户目录配置'
  })
  expect((await readProjects(canonical)).map((item) => item.id)).toEqual(['desktop-1', 'baseline'])
  await expect(readFile(join(canonical, 'dev-recovery.json'))).rejects.toMatchObject({
    code: 'ENOENT'
  })

  await rm(join(legacy, 'operations', brokenName), { recursive: true, force: true })
  const retried = await recoverLegacyUserDirectory(canonical)

  expect(retried).toMatchObject({ recovered: 0, sources: 1 })
  expect((await readProjects(canonical)).map((item) => item.id)).toEqual(['desktop-1', 'baseline'])
  expect(JSON.parse(await readFile(join(canonical, 'dev-recovery.json'), 'utf8'))).toEqual({
    version: 1,
    sources: ['.opengalgame ']
  })
})
