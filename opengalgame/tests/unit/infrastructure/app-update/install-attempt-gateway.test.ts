import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { UserDataInstallAttemptGatewayImpl } from '@infrastructure/app-update/UserDataInstallAttemptGatewayImpl'

const directories: string[] = []

afterEach(async () => {
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true })
})

async function temporaryPath(): Promise<{ directory: string; filePath: string }> {
  const directory = await mkdtemp(join(tmpdir(), 'opengalgame-app-update-'))
  directories.push(directory)
  return {
    directory,
    filePath: join(directory, 'app-update', 'install-attempt.json')
  }
}

describe('本机更新安装记录', () => {
  it('缺失记录为 null，记录后可跨实例读取且格式版本固定', async () => {
    const { filePath } = await temporaryPath()
    const first = new UserDataInstallAttemptGatewayImpl(filePath)
    expect(await first.read()).toBeNull()

    await first.record({
      fromVersion: '0.1.0',
      toVersion: '0.1.1',
      attemptedAt: '2026-11-12T03:04:05.000Z'
    })

    const second = new UserDataInstallAttemptGatewayImpl(filePath)
    expect(await second.read()).toEqual({
      fromVersion: '0.1.0',
      toVersion: '0.1.1',
      attemptedAt: '2026-11-12T03:04:05.000Z'
    })
    expect(JSON.parse(await readFile(filePath, 'utf8'))).toEqual({
      formatVersion: 1,
      fromVersion: '0.1.0',
      toVersion: '0.1.1',
      attemptedAt: '2026-11-12T03:04:05.000Z'
    })
  })

  it('清理幂等，重复清理不失败', async () => {
    const { filePath } = await temporaryPath()
    const gateway = new UserDataInstallAttemptGatewayImpl(filePath)
    await gateway.record({
      fromVersion: '0.1.0',
      toVersion: '0.1.1',
      attemptedAt: '2026-11-12T03:04:05.000Z'
    })

    await gateway.clear()
    expect(await gateway.read()).toBeNull()
    await gateway.clear()
    expect(await gateway.read()).toBeNull()
  })

  it('内容损坏或形状不符时明确拒绝，不返回假记录', async () => {
    const { directory, filePath } = await temporaryPath()
    await mkdir(join(directory, 'app-update'), { recursive: true })
    await writeFile(filePath, '{broken', 'utf8')
    const gateway = new UserDataInstallAttemptGatewayImpl(filePath)

    await expect(gateway.read()).rejects.toMatchObject({
      code: 5103,
      message: '更新安装记录读写失败'
    })
  })

  it.each([
    { formatVersion: 2, fromVersion: '0.1.0', toVersion: '0.1.1', attemptedAt: 'x' },
    { formatVersion: 1, fromVersion: '0.1', toVersion: '0.1.1', attemptedAt: 'x' },
    { formatVersion: 1, fromVersion: '0.1.0', toVersion: '0.1.1' }
  ])('拒绝不符合固定格式的内容 %j', async (document) => {
    const { directory, filePath } = await temporaryPath()
    await mkdir(join(directory, 'app-update'), { recursive: true })
    await writeFile(filePath, JSON.stringify(document), 'utf8')
    const gateway = new UserDataInstallAttemptGatewayImpl(filePath)

    await expect(gateway.read()).rejects.toMatchObject({ code: 5103 })
  })
})
