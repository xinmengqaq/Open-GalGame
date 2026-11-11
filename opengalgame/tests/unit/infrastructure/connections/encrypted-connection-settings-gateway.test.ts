import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

import { EncryptedConnectionSettingsGatewayImpl } from '@infrastructure/connections/EncryptedConnectionSettingsGatewayImpl'
import type { SecretCipher } from '@infrastructure/security/SecretCipher'
import type { ConnectionSettingsInfo } from '@domain/connections/models/ConnectionSettings'

const secret = 'session-secret-value'

function cipher(): SecretCipher {
  return {
    encrypt: vi.fn((value: string) => Buffer.from(Buffer.from(value).map((byte) => byte ^ 53))),
    decrypt: vi.fn((value: Buffer) => Buffer.from(value.map((byte) => byte ^ 53)).toString('utf8'))
  }
}

const settings: ConnectionSettingsInfo = {
  providerId: 'openai-compatible',
  baseUrl: 'https://service.example/v1',
  model: 'chosen',
  contextWindow: 128000,
  maxOutputTokens: 4096,
  apiKey: 'stored-key',
  extension: { defaultHeaders: { 'x-opencode-session': secret } }
}

describe('加密连接设置中的扩展 JSON', () => {
  it('扩展密文与密钥同修订写入凭据文件，摘要和模型文件不含明文', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'opengalgame-extension-'))
    const gateway = new EncryptedConnectionSettingsGatewayImpl(directory, cipher())
    const summary = await gateway.saveSettings(settings)
    const models = JSON.parse(await readFile(join(directory, 'models.json'), 'utf8')) as Record<
      string,
      unknown
    >
    const credentials = JSON.parse(await readFile(join(directory, 'credentials.json'), 'utf8')) as {
      revision: string
      encryptedExtension: string
    }

    expect(summary).toMatchObject({ hasApiKey: true, hasExtension: true })
    expect(JSON.stringify(summary)).not.toContain(secret)
    expect(models).not.toHaveProperty('extension')
    expect(JSON.stringify(models)).not.toContain(secret)
    expect(credentials.revision).toBe(models.revision)
    expect(credentials.encryptedExtension).toEqual(expect.any(String))
    expect(credentials.encryptedExtension).not.toContain(secret)
    expect(await gateway.loadSettings()).toMatchObject({ extension: settings.extension })
    expect(await gateway.getSummary()).toMatchObject({ hasExtension: true })
    expect(JSON.stringify(await gateway.getSummary())).not.toContain(secret)
  })

  it('清空扩展后不再保存密文字段，摘要改为未配置', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'opengalgame-extension-'))
    const gateway = new EncryptedConnectionSettingsGatewayImpl(directory, cipher())
    await gateway.saveSettings(settings)
    const cleared = { ...settings }
    delete cleared.extension
    expect(await gateway.saveSettings(cleared)).toMatchObject({ hasExtension: false })
    const credentials = JSON.parse(
      await readFile(join(directory, 'credentials.json'), 'utf8')
    ) as Record<string, unknown>
    expect(credentials).not.toHaveProperty('encryptedExtension')
    expect(await gateway.loadSettings()).not.toHaveProperty('extension')
  })

  it('修订号不匹配时不采用扩展，解密失败按凭据读取失败处理', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'opengalgame-extension-'))
    const gateway = new EncryptedConnectionSettingsGatewayImpl(directory, cipher())
    await gateway.saveSettings(settings)
    const credentialsPath = join(directory, 'credentials.json')
    const credentials = JSON.parse(await readFile(credentialsPath, 'utf8')) as Record<
      string,
      unknown
    >
    await writeFile(
      credentialsPath,
      JSON.stringify({ ...credentials, revision: '00000000-0000-4000-8000-000000000001' })
    )
    expect(await gateway.getSummary()).toMatchObject({ hasApiKey: false, hasExtension: false })
    await expect(gateway.loadSettings()).resolves.toBeNull()

    await gateway.saveSettings(settings)
    const broken = {
      ...(JSON.parse(await readFile(credentialsPath, 'utf8')) as Record<string, unknown>),
      encryptedExtension: Buffer.from('not-ciphertext').toString('base64')
    }
    await writeFile(credentialsPath, JSON.stringify(broken))
    const failing = new EncryptedConnectionSettingsGatewayImpl(directory, {
      encrypt: cipher().encrypt,
      decrypt: () => {
        throw new Error(secret)
      }
    })
    await expect(failing.loadSettings()).rejects.toMatchObject({
      code: 1408,
      message: '无法安全读取密钥，请重新填写'
    })
    await expect(failing.loadSettings()).rejects.not.toMatchObject({
      message: expect.stringContaining(secret)
    })
  })
})
