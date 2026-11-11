import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { SystemPathErrorCodes } from '@domain/system-path/errors/SystemPathErrorCodes'
import { LocalDirectoryOpenGateway } from '@infrastructure/system-path/LocalDirectoryOpenGateway'

let directory: string

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'scene-open-'))
})

afterEach(async () => {
  await rm(directory, { recursive: true, force: true })
})

describe('本机目录打开网关', () => {
  it('存在的绝对目录交给系统打开一次', async () => {
    const openPath = vi.fn(async () => '')
    const gateway = new LocalDirectoryOpenGateway(openPath)

    await expect(gateway.openDirectory(directory)).resolves.toBeUndefined()
    expect(openPath).toHaveBeenCalledOnce()
    expect(openPath).toHaveBeenCalledWith(directory)
  })

  it('相对路径、不存在的路径和普通文件都拒绝，且不交给系统', async () => {
    const openPath = vi.fn(async () => '')
    const gateway = new LocalDirectoryOpenGateway(openPath)
    const regularFile = join(directory, 'note.txt')
    await writeFile(regularFile, 'x', 'utf8')

    await expect(gateway.openDirectory('relative/dir')).rejects.toMatchObject({
      code: SystemPathErrorCodes.pathRejected
    })
    await expect(gateway.openDirectory(join(directory, 'missing'))).rejects.toMatchObject({
      code: SystemPathErrorCodes.pathRejected
    })
    await expect(gateway.openDirectory(regularFile)).rejects.toMatchObject({
      code: SystemPathErrorCodes.pathRejected
    })
    expect(openPath).not.toHaveBeenCalled()
  })

  it('系统返回错误文本或抛错时给出明确的打开失败码', async () => {
    const failure = new LocalDirectoryOpenGateway(async () => '系统无法打开该目录')
    await expect(failure.openDirectory(directory)).rejects.toMatchObject({
      code: SystemPathErrorCodes.openFailed
    })

    const thrown = new LocalDirectoryOpenGateway(async () => {
      throw new Error('boom')
    })
    await expect(thrown.openDirectory(directory)).rejects.toMatchObject({
      code: SystemPathErrorCodes.openFailed
    })
  })
})
