import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { FilePromptLoader } from '@infrastructure/ai/prompts/FilePromptLoader'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('文件系统提示词', () => {
  it('读取有效正文并给出稳定摘要，已创建结果不随后续文件变化', async () => {
    const root = await createRoot()
    await writePrompt(root, 'reader', '第一版正文')
    const loader = new FilePromptLoader(root)
    const first = await loader.load({ agentId: 'reader' })
    const digest = createHash('sha256').update(Buffer.from('第一版正文')).digest('hex')

    expect(first.body).toBe('第一版正文')
    expect(first.digest).toBe(digest)
    await writePrompt(root, 'reader', '第二版正文')
    expect(first.body).toBe('第一版正文')
    expect((await loader.load({ agentId: 'reader' })).body).toBe('第二版正文')
  })

  it('缺失、空白、非法编码、绝对路径和越界路径都失败', async () => {
    const root = await createRoot()
    const loader = new FilePromptLoader(root)
    const outside = await createRoot()

    await expect(loader.load({ agentId: 'missing' })).rejects.toThrow('系统提示词不存在')
    await writePrompt(root, 'blank', ' \n\t')
    await expect(loader.load({ agentId: 'blank' })).rejects.toThrow('系统提示词为空')
    await mkdir(join(root, 'bad-encoding'))
    await writeFile(join(root, 'bad-encoding', 'system.md'), Buffer.from([0xff, 0xfe, 0xfd]))
    await expect(loader.load({ agentId: 'bad-encoding' })).rejects.toThrow(
      '系统提示词不是合法的 UTF-8'
    )
    await expect(loader.load({ agentId: 'C:/windows' })).rejects.toThrow('系统提示词引用无效')
    await expect(loader.load({ agentId: '../secret' })).rejects.toThrow('系统提示词引用无效')
    await expect(new FilePromptLoader(outside).load({ agentId: 'reader' })).rejects.toThrow(
      '系统提示词不存在'
    )
  })

  it('构造时固定资源根，之后改变工作目录仍读取原目录', async () => {
    const root = await createRoot()
    await writePrompt(root, 'reader', '固定正文')
    const previous = process.cwd()
    process.chdir(dirname(root))
    try {
      const loader = new FilePromptLoader(basename(root))
      process.chdir(tmpdir())
      await expect(loader.load({ agentId: 'reader' })).resolves.toMatchObject({
        body: '固定正文'
      })
    } finally {
      process.chdir(previous)
    }
  })

  it('改变当前工作目录不影响读取', async () => {
    const root = await createRoot()
    await writePrompt(root, 'reader', '固定正文')
    const previous = process.cwd()
    process.chdir(tmpdir())
    try {
      await expect(new FilePromptLoader(root).load({ agentId: 'reader' })).resolves.toMatchObject({
        body: '固定正文'
      })
    } finally {
      process.chdir(previous)
    }
  })

  it('越界链接失败；不能创建链接时跳过', async (ctx) => {
    const root = await createRoot()
    const outside = await createRoot()
    const outsideFile = join(outside, 'secret.md')
    await writeFile(outsideFile, '区外正文')
    await mkdir(join(root, 'linked'))
    try {
      await symlink(outsideFile, join(root, 'linked', 'system.md'), 'file')
    } catch {
      ctx.skip()
      return
    }
    await expect(new FilePromptLoader(root).load({ agentId: 'linked' })).rejects.toThrow(
      '路径超出允许范围'
    )
  })
})

async function createRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'prompt-'))
  roots.push(root)
  return root
}

async function writePrompt(root: string, agentId: string, body: string): Promise<void> {
  await mkdir(join(root, agentId), { recursive: true })
  await writeFile(join(root, agentId, 'system.md'), body, 'utf8')
}
