import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { withFileTurn } from '@infrastructure/storage/fileTurn'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('同文件串行轮次', () => {
  it('同一绝对路径的写入按调用顺序完成', async () => {
    const root = await mkdtemp(join(tmpdir(), 'file-turn-'))
    roots.push(root)
    const path = join(root, 'scene.txt')
    const order: string[] = []

    await Promise.all([
      withFileTurn(path, async () => {
        order.push('first:start')
        await writeFile(path, 'one')
        order.push('first:end')
      }),
      withFileTurn(path, async () => {
        order.push('second:start')
        await writeFile(path, 'two')
        order.push('second:end')
      })
    ])

    expect(order).toEqual(['first:start', 'first:end', 'second:start', 'second:end'])
  })

  it('前一次失败不阻塞同一路径的后续轮次', async () => {
    const root = await mkdtemp(join(tmpdir(), 'file-turn-'))
    roots.push(root)
    const path = join(root, 'scene.txt')

    await expect(
      withFileTurn(path, async () => {
        throw new Error('write failed')
      })
    ).rejects.toThrow('write failed')
    await expect(withFileTurn(path, async () => 'recovered')).resolves.toBe('recovered')
  })
})
