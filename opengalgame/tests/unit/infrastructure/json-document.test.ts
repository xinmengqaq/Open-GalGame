import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    writeFile: vi.fn((...args: Parameters<typeof actual.writeFile>) => actual.writeFile(...args))
  }
})

import {
  deleteJsonDocument,
  isTemporaryDocumentName,
  listDocumentNames,
  readJsonDocument,
  writeJsonDocument
} from '@infrastructure/storage/jsonDocument'

const failure = { code: 1304, msg: '本机存储读写失败' }
const directories: string[] = []

afterEach(async () => {
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true })
})

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'opengalgame-document-'))
  directories.push(directory)
  return directory
}

describe('本机 JSON 文档', () => {
  it('读取缺失文件为空；写入建立目录并整份替换', async () => {
    const root = await temporaryDirectory()
    const path = join(root, 'app', 'projects.json')

    expect(await readJsonDocument(path, failure)).toBeNull()
    await writeJsonDocument(path, { registrations: [] }, failure)
    expect(await readJsonDocument(path, failure)).toEqual({ registrations: [] })
    expect(await readFile(path, 'utf8')).toContain('\n  ')
    await writeJsonDocument(path, { registrations: [{ id: 'a' }] }, failure)
    expect(await readJsonDocument(path, failure)).toEqual({ registrations: [{ id: 'a' }] })
  })

  it('紧凑写入不缩进，仍保留正文', async () => {
    const root = await temporaryDirectory()
    const path = join(root, 'canvas.json')
    await writeJsonDocument(path, { body: '  保留\n换行  ' }, failure, { compact: true })
    const text = await readFile(path, 'utf8')
    expect(text).toBe('{"body":"  保留\\n换行  "}')
    expect(text).not.toContain('\n  ')
  })

  it('写入完成后不留下临时文件', async () => {
    const root = await temporaryDirectory()
    await writeJsonDocument(join(root, 'models.json'), { model: 'a' }, failure)

    expect(await readdir(root)).toEqual(['models.json'])
    expect(isTemporaryDocumentName('.opengalgame-tmp-0d1f')).toBe(true)
    expect(isTemporaryDocumentName('models.json')).toBe(false)
  })

  it('内容不是合法 JSON 时用调用方的错误码拒绝', async () => {
    const root = await temporaryDirectory()
    const path = join(root, 'projects.json')
    await writeFile(path, '{broken', 'utf8')

    await expect(
      readJsonDocument(path, { code: 1304, msg: '本机项目登记读写失败' })
    ).rejects.toMatchObject({ code: 1304, message: '本机项目登记读写失败' })
  })

  it('磁盘满使用调用方给出的错误码，不固定成项目码', async () => {
    const root = await temporaryDirectory()
    vi.mocked(writeFile).mockRejectedValueOnce(Object.assign(new Error('full'), { code: 'ENOSPC' }))

    await expect(
      writeJsonDocument(
        join(root, 'models.json'),
        { model: 'a' },
        {
          code: 1409,
          msg: '连接设置保存失败',
          diskFull: { code: 1409, msg: '磁盘空间不足' }
        }
      )
    ).rejects.toMatchObject({ code: 1409, message: '磁盘空间不足' })
  })

  it('目录不存在时列举为空，删除缺失文件不报错', async () => {
    const root = await temporaryDirectory()

    expect(await listDocumentNames(join(root, 'operations'), failure)).toEqual([])
    await expect(deleteJsonDocument(join(root, 'operations', 'gone.json'), failure)).resolves.toBe(
      undefined
    )
  })
})
