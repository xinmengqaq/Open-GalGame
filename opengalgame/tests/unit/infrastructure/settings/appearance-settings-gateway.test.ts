import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    readFile: vi.fn((...args: Parameters<typeof actual.readFile>) => actual.readFile(...args)),
    rename: vi.fn((...args: Parameters<typeof actual.rename>) => actual.rename(...args))
  }
})

import {
  AppearanceErrorCodes,
  AppearanceErrorMessages
} from '@domain/settings/appearance/errors/AppearanceErrorCodes'
import type { AppearanceSettings } from '@domain/settings/appearance/models/AppearanceSettings'
import { AppearanceSettingsGatewayImpl } from '@infrastructure/settings/AppearanceSettingsGatewayImpl'

const savedSettings: AppearanceSettings = {
  fontPresetId: 'source-han-serif',
  bodyTextSize: 18,
  glassOpacity: 55,
  highContrast: true,
  reducedMotion: 'off',
  themePreset: 'default'
}

const corruptMessage =
  AppearanceErrorMessages[AppearanceErrorCodes.corruptAppearanceSettings]
const unsupportedVersionMessage =
  AppearanceErrorMessages[AppearanceErrorCodes.unsupportedAppearanceSettingsVersion]
const readFailedMessage =
  AppearanceErrorMessages[AppearanceErrorCodes.appearanceSettingsReadFailed]
const saveFailedMessage =
  AppearanceErrorMessages[AppearanceErrorCodes.appearanceSettingsSaveFailed]

const directories: string[] = []

afterEach(async () => {
  vi.mocked(readFile).mockClear()
  vi.mocked(rename).mockClear()
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true })
})

async function temporaryUserDirectory(): Promise<{ directory: string; filePath: string }> {
  const directory = await mkdtemp(join(tmpdir(), 'opengalgame-appearance-'))
  directories.push(directory)
  return { directory, filePath: join(directory, 'appearance.json') }
}

function documentFor(settings: AppearanceSettings): Record<string, unknown> {
  return { formatVersion: 1, ...settings }
}

function documentWithout(settings: AppearanceSettings, key: keyof AppearanceSettings): object {
  const document = documentFor(settings)
  delete document[key]
  return document
}

describe('外观设置文件网关', () => {
  it('文件缺失时返回 null，不创建文件', async () => {
    const { directory } = await temporaryUserDirectory()

    await expect(new AppearanceSettingsGatewayImpl(directory).read()).resolves.toBeNull()
    await expect(readdir(directory)).resolves.toEqual([])
  })

  it('保存六项和格式版本后可由新实例完整读取，文件恰好七字段', async () => {
    const { directory, filePath } = await temporaryUserDirectory()
    await new AppearanceSettingsGatewayImpl(directory).save(savedSettings)

    const document = JSON.parse(await readFile(filePath, 'utf8'))
    expect(document).toEqual({ formatVersion: 1, ...savedSettings })
    expect(Object.keys(document)).toHaveLength(7)
    await expect(readdir(directory)).resolves.toEqual(['appearance.json'])
    await expect(new AppearanceSettingsGatewayImpl(directory).read()).resolves.toEqual(
      savedSettings
    )
  })

  it('再次保存整文件覆盖，不读取或合并旧值', async () => {
    const { directory, filePath } = await temporaryUserDirectory()
    const gateway = new AppearanceSettingsGatewayImpl(directory)
    await gateway.save(savedSettings)

    const replacement: AppearanceSettings = {
      fontPresetId: 'system',
      bodyTextSize: 12,
      glassOpacity: 90,
      highContrast: false,
      reducedMotion: 'system',
      themePreset: 'default'
    }
    await gateway.save(replacement)

    expect(JSON.parse(await readFile(filePath, 'utf8'))).toEqual(documentFor(replacement))
    await expect(gateway.read()).resolves.toEqual(replacement)
  })

  const corruptDocuments: { name: string; content: string }[] = [
    { name: 'JSON 无法解析', content: '{broken' },
    {
      name: '版本是字符串',
      content: JSON.stringify({ ...documentFor(savedSettings), formatVersion: '1' })
    },
    {
      name: '版本是小数',
      content: JSON.stringify({ ...documentFor(savedSettings), formatVersion: 1.5 })
    },
    { name: '缺少版本字段', content: JSON.stringify(savedSettings) },
    {
      name: '版本 1 缺少字段',
      content: JSON.stringify(documentWithout(savedSettings, 'highContrast'))
    },
    {
      name: '版本 1 存在未知字段',
      content: JSON.stringify({ ...documentFor(savedSettings), extra: true })
    },
    {
      name: '字段类型错误',
      content: JSON.stringify({ ...documentFor(savedSettings), bodyTextSize: '18' })
    },
    {
      name: '动效不是三态',
      content: JSON.stringify({ ...documentFor(savedSettings), reducedMotion: 'auto' })
    }
  ]

  it.each(corruptDocuments)('$name 返回 1502 并保留原文件', async ({ content }) => {
    const { directory, filePath } = await temporaryUserDirectory()
    await writeFile(filePath, content, 'utf8')
    const before = await readFile(filePath)

    await expect(new AppearanceSettingsGatewayImpl(directory).read()).rejects.toMatchObject({
      code: AppearanceErrorCodes.corruptAppearanceSettings,
      message: corruptMessage
    })
    expect(await readFile(filePath)).toEqual(before)
  })

  it.each([2, 0])('整数版本 %i 返回 1503 并保留原文件', async (formatVersion) => {
    const { directory, filePath } = await temporaryUserDirectory()
    await writeFile(filePath, JSON.stringify({ formatVersion }), 'utf8')
    const before = await readFile(filePath)

    await expect(new AppearanceSettingsGatewayImpl(directory).read()).rejects.toMatchObject({
      code: AppearanceErrorCodes.unsupportedAppearanceSettingsVersion,
      message: unsupportedVersionMessage
    })
    expect(await readFile(filePath)).toEqual(before)
  })

  it('未来版本优先于字段校验返回 1503', async () => {
    const { directory, filePath } = await temporaryUserDirectory()
    await writeFile(filePath, JSON.stringify({ formatVersion: 2, unknown: true }), 'utf8')

    await expect(new AppearanceSettingsGatewayImpl(directory).read()).rejects.toMatchObject({
      code: AppearanceErrorCodes.unsupportedAppearanceSettingsVersion
    })
  })

  it('类型正确但未登记或越界的值交给领域判定，不按损坏拒绝', async () => {
    const { directory, filePath } = await temporaryUserDirectory()
    const settings: AppearanceSettings = {
      fontPresetId: 'not-registered',
      bodyTextSize: 25,
      glassOpacity: 72,
      highContrast: false,
      reducedMotion: 'on',
      themePreset: 'neon'
    }
    await writeFile(filePath, JSON.stringify(documentFor(settings)), 'utf8')

    await expect(new AppearanceSettingsGatewayImpl(directory).read()).resolves.toEqual(settings)
  })

  it.each(['EACCES', 'EPERM', 'ENOSPC'])(
    '读取 IO 错误 %s 返回 1504 设计文案',
    async (code) => {
      const { directory, filePath } = await temporaryUserDirectory()
      await writeFile(filePath, JSON.stringify(documentFor(savedSettings)), 'utf8')
      vi.mocked(readFile).mockRejectedValueOnce(Object.assign(new Error('read failed'), { code }))

      await expect(new AppearanceSettingsGatewayImpl(directory).read()).rejects.toMatchObject({
        code: AppearanceErrorCodes.appearanceSettingsReadFailed,
        message: readFailedMessage
      })
    }
  )

  it('其他读取 IO 错误返回 1504 且消息不暴露路径', async () => {
    const { directory, filePath } = await temporaryUserDirectory()
    await mkdir(filePath)

    const error = await new AppearanceSettingsGatewayImpl(directory).read().catch((reason) => reason)

    expect(error).toMatchObject({
      code: AppearanceErrorCodes.appearanceSettingsReadFailed,
      message: readFailedMessage
    })
    expect((error as Error).message).not.toContain(directory)
  })

  it.each(['EACCES', 'EPERM', 'ENOSPC'])(
    '替换失败 %s 返回 1505 设计文案，旧文件与内容保持不变且不残留临时文件',
    async (code) => {
      const { directory, filePath } = await temporaryUserDirectory()
      const gateway = new AppearanceSettingsGatewayImpl(directory)
      await gateway.save(savedSettings)
      const before = await readFile(filePath)
      vi.mocked(rename).mockRejectedValueOnce(
        Object.assign(new Error('write denied'), { code })
      )

      await expect(gateway.save({ ...savedSettings, bodyTextSize: 20 })).rejects.toMatchObject({
        code: AppearanceErrorCodes.appearanceSettingsSaveFailed,
        message: saveFailedMessage
      })
      expect(await readFile(filePath)).toEqual(before)
      await expect(gateway.read()).resolves.toEqual(savedSettings)
      const names = await readdir(directory)
      expect(names.filter((name) => name.startsWith('.opengalgame-tmp-'))).toEqual([])
    }
  )
})
