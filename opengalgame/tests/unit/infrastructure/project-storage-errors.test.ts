import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { Project } from '@domain/projects/models/Project'
import { LocalProjectStorageGatewayImpl } from '@infrastructure/projects/LocalProjectStorageGatewayImpl'

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, readFile: vi.fn(actual.readFile) }
})

const directories: string[] = []
afterEach(async () => {
  vi.mocked(readFile).mockClear()
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true })
})

describe('工程清单错误归属', () => {
  it('清单检查后读取失败仍保留文件错误', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'opengalgame-manifest-'))
    directories.push(directory)
    await mkdir(join(directory, '.opengalgame'))
    await writeFile(join(directory, '.opengalgame', 'manifest.json'), '{}')
    const failure = Object.assign(new Error('read failed'), { code: 'EACCES' })
    vi.mocked(readFile).mockRejectedValueOnce(failure)

    await expect(new LocalProjectStorageGatewayImpl().inspect({ directory })).rejects.toMatchObject(
      {
        code: 1301,
        cause: failure
      }
    )
  })

  it('清单检查后文件消失按缺少清单处理', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'opengalgame-manifest-'))
    directories.push(directory)
    await mkdir(join(directory, '.opengalgame'))
    await writeFile(join(directory, '.opengalgame', 'manifest.json'), '{}')
    vi.mocked(readFile).mockRejectedValueOnce(Object.assign(new Error('gone'), { code: 'ENOENT' }))

    await expect(new LocalProjectStorageGatewayImpl().inspect({ directory })).rejects.toMatchObject(
      {
        code: 1206,
        message: '已有工程缺少身份清单'
      }
    )
  })
})

describe('写回工程信息', () => {
  const project = Project.restore({ id: 'story-1', name: '故事' })

  it('目录不存在时返回缺失', async () => {
    const root = await mkdtemp(join(tmpdir(), 'opengalgame-missing-'))
    directories.push(root)

    await expect(
      new LocalProjectStorageGatewayImpl().saveProjectInfo(
        { directory: join(root, 'gone') },
        project
      )
    ).resolves.toBe('missing')
  })

  it('目录链接拒绝写回，不伪装成内容缺失', async () => {
    const root = await mkdtemp(join(tmpdir(), 'opengalgame-link-'))
    const target = await mkdtemp(join(tmpdir(), 'opengalgame-target-'))
    directories.push(root, target)
    const link = join(root, 'link')
    await symlink(target, link, 'junction')

    await expect(
      new LocalProjectStorageGatewayImpl().saveProjectInfo({ directory: link }, project)
    ).rejects.toMatchObject({ code: 1308, message: '请选择真实目录，不支持目录链接' })
  })
})
