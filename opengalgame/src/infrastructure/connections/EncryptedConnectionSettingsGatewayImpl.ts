import { randomUUID } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'

import type { SecretCipher } from '../security/SecretCipher'
import {
  deleteJsonDocument,
  mapStorageFailure,
  readJsonDocument,
  writeJsonDocument,
  type StorageFailure
} from '../storage/jsonDocument'
import { parseUnknownValue } from '../validation/parseUnknownValue'
import type { ConnectionSettingsGateway } from '@application/connections/ports/ConnectionSettingsGateway'
import type { ConnectionSettingsVO } from '@application/connections/vo/ConnectionSettingsVO'
import { AppException } from '@common/errors/AppException'
import { ConnectionErrorCodes } from '@domain/connections/errors/ConnectionErrorCodes'
import type {
  ConnectionExtension,
  ConnectionSettingsInfo
} from '@domain/connections/models/ConnectionSettings'

const CONNECTION_MODELS_FILE_NAME = 'models.json'
const CONNECTION_CREDENTIALS_FILE_NAME = 'credentials.json'

const providerIdSchema = z.enum(['openai-compatible', 'anthropic'])
const connectionSettingsDocumentSchema = z.strictObject({
  providerId: providerIdSchema,
  baseUrl: z.string(),
  model: z.string(),
  contextWindow: z.number().int().positive(),
  maxOutputTokens: z.number().int().positive(),
  temperature: z.number().min(0).max(1).optional(),
  topP: z.number().min(0).max(1).optional(),
  revision: z.string().uuid()
})
const connectionCredentialsDocumentSchema = z.strictObject({
  providerId: providerIdSchema,
  baseUrl: z.string(),
  revision: z.string().uuid(),
  encryptedKey: z.string().min(1),
  encryptedExtension: z.string().min(1).optional()
})

type ConnectionSettingsDocument = z.infer<typeof connectionSettingsDocumentSchema>
type ConnectionCredentialsDocument = z.infer<typeof connectionCredentialsDocumentSchema>

const technicalFailure = {
  diskFull: { code: ConnectionErrorCodes.settingsSaveFailed, msg: '磁盘空间不足' },
  notWritable: {
    code: ConnectionErrorCodes.settingsSaveFailed,
    msg: '保存位置不可访问或不可写'
  }
}
const saveFailure: StorageFailure = {
  code: ConnectionErrorCodes.settingsSaveFailed,
  msg: '连接设置保存失败',
  ...technicalFailure
}
const readFailure: StorageFailure = {
  code: ConnectionErrorCodes.settingsSaveFailed,
  msg: '连接设置读取失败',
  ...technicalFailure
}
const credentialReadFailure: StorageFailure = {
  code: ConnectionErrorCodes.credentialStoreFailed,
  msg: '连接设置读取失败',
  ...technicalFailure
}

/**
 * 密钥只对同一次写入的协议、地址和修订号有效。错配或中断留下的组合不采用。
 * @param credentials - 已保存的密钥文档。
 * @returns 密钥与配置属于同一次写入时为 true。
 */
function belongsToModels(
  credentials: ConnectionCredentialsDocument,
  models: ConnectionSettingsDocument
): boolean {
  return (
    credentials.providerId === models.providerId &&
    credentials.baseUrl === models.baseUrl &&
    credentials.revision === models.revision
  )
}

/**
 * 密钥内容损坏才当成没有密钥。磁盘、权限和其他读取失败继续抛出。
 * @param error - 读取密钥时捕获的失败。
 * @returns 失败源于密钥内容损坏时为 true。
 */
function isDamagedCredentials(error: unknown): boolean {
  if (
    !(error instanceof AppException) ||
    error.code !== ConnectionErrorCodes.credentialStoreFailed
  ) {
    return false
  }
  return error.cause === undefined || error.cause instanceof SyntaxError
}

/**
 * 去掉内部修订号，得到可对外展示的设置。
 * @returns 不含修订号的可见设置。
 */
function visibleSettings(
  models: ConnectionSettingsDocument
): Omit<ConnectionSettingsDocument, 'revision'> {
  return {
    providerId: models.providerId,
    baseUrl: models.baseUrl,
    model: models.model,
    contextWindow: models.contextWindow,
    maxOutputTokens: models.maxOutputTokens,
    temperature: models.temperature,
    topP: models.topP
  }
}

export class EncryptedConnectionSettingsGatewayImpl implements ConnectionSettingsGateway {
  /**
   * @param userDirectory - 用户级 `.opengalgame` 目录，配置与密钥分开放在这里。
   */
  constructor(
    private readonly userDirectory: string,
    private readonly cipher: SecretCipher,
    private readonly documents = {
      models: CONNECTION_MODELS_FILE_NAME,
      credentials: CONNECTION_CREDENTIALS_FILE_NAME
    }
  ) {}

  /** 查询时不解密凭据。 */
  async getSummary(): Promise<ConnectionSettingsVO | null> {
    const models = await this.readModels()
    if (!models) return null
    const credentials = await this.readCredentials()
    return {
      ...visibleSettings(models),
      hasApiKey: credentials !== null && belongsToModels(credentials, models),
      hasExtension:
        credentials?.encryptedExtension !== undefined && belongsToModels(credentials, models)
    }
  }

  /** 只读加载内部配置，解密失败由技术边界转换。 */
  async loadSettings(): Promise<ConnectionSettingsInfo | null> {
    const models = await this.readModels()
    if (!models) return null
    const credentials = await this.readCredentials()
    if (!credentials || !belongsToModels(credentials, models)) return null
    try {
      const extension = credentials.encryptedExtension
        ? parseStoredExtension(
            this.cipher.decrypt(Buffer.from(credentials.encryptedExtension, 'base64'))
          )
        : undefined
      return {
        ...visibleSettings(models),
        apiKey: this.cipher.decrypt(Buffer.from(credentials.encryptedKey, 'base64')),
        ...(extension === undefined ? {} : { extension })
      }
    } catch (error) {
      throw new AppException({
        code: ConnectionErrorCodes.credentialStoreFailed,
        msg: '无法安全读取密钥，请重新填写',
        cause: error
      })
    }
  }

  /** 先加密，再写密钥与配置。配置写入失败时恢复原密钥文件。 */
  async saveSettings(settings: ConnectionSettingsInfo): Promise<ConnectionSettingsVO> {
    let encryptedKey: string
    let encryptedExtension: string | undefined
    try {
      encryptedKey = this.cipher.encrypt(settings.apiKey).toString('base64')
      encryptedExtension =
        settings.extension === undefined
          ? undefined
          : this.cipher.encrypt(JSON.stringify(settings.extension)).toString('base64')
    } catch (error) {
      throw new AppException({
        code: ConnectionErrorCodes.credentialStoreFailed,
        msg: '无法安全保存密钥，原设置保持不变',
        cause: error
      })
    }
    const revision = randomUUID()
    const models: ConnectionSettingsDocument = {
      providerId: settings.providerId,
      baseUrl: settings.baseUrl,
      model: settings.model,
      contextWindow: settings.contextWindow,
      maxOutputTokens: settings.maxOutputTokens,
      temperature: settings.temperature,
      topP: settings.topP,
      revision
    }
    const previousCredentials = await this.readCredentialsBytes()
    try {
      await writeJsonDocument(
        this.credentialsFile,
        {
          providerId: settings.providerId,
          baseUrl: settings.baseUrl,
          revision,
          encryptedKey,
          ...(encryptedExtension === undefined ? {} : { encryptedExtension })
        } satisfies ConnectionCredentialsDocument,
        saveFailure
      )
      await writeJsonDocument(this.modelsFile, models, saveFailure)
    } catch (error) {
      await this.restoreCredentials(previousCredentials, error)
      throw error
    }
    return {
      ...visibleSettings(models),
      hasApiKey: true,
      hasExtension: encryptedExtension !== undefined
    }
  }

  private get modelsFile(): string {
    return join(this.userDirectory, this.documents.models)
  }

  /** 密钥文档路径。 @returns 用户目录下的密钥文档路径。 */
  private get credentialsFile(): string {
    return join(this.userDirectory, this.documents.credentials)
  }

  /**
   * @returns 模型配置文档；文件不存在时为 null。
   * @throws {AppException} 读取失败或内容损坏。
   */
  private async readModels(): Promise<ConnectionSettingsDocument | null> {
    const value = await readJsonDocument(this.modelsFile, readFailure)
    if (value === null) return null
    return parseUnknownValue(
      connectionSettingsDocumentSchema,
      value,
      ConnectionErrorCodes.invalidConnectionConfig,
      '已保存的连接配置损坏'
    )
  }

  /**
   * 密钥文件缺失或内容损坏按没有可用密钥处理。磁盘与权限失败继续抛出。
   * @returns 凭据文档；缺失或损坏时为 null。
   */
  private async readCredentials(): Promise<ConnectionCredentialsDocument | null> {
    try {
      const value = await readJsonDocument(this.credentialsFile, credentialReadFailure)
      if (value === null) return null
      return parseUnknownValue(
        connectionCredentialsDocumentSchema,
        value,
        ConnectionErrorCodes.credentialStoreFailed,
        '已保存的密钥损坏'
      )
    } catch (error) {
      if (isDamagedCredentials(error)) return null
      throw error
    }
  }

  /**
   * 记住写入前的密钥文件字节，供配置写入失败时原样恢复。
   * @returns 写入前的文件内容；原来没有文件时为 null。
   * @throws {AppException} 读取失败且不是文件不存在。
   */
  private async readCredentialsBytes(): Promise<string | null> {
    try {
      return await readFile(this.credentialsFile, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw mapStorageFailure(error, saveFailure)
    }
  }

  /**
   * 配置没写上时恢复密钥文件。恢复也失败时保留两次失败。
   * @param previous - 写入前的文件内容；原来没有文件时为 null。
   * @param error - 本次保存失败。
   * @throws {AppException} 密钥文件无法恢复。
   */
  private async restoreCredentials(previous: string | null, error: unknown): Promise<void> {
    try {
      if (previous === null) {
        await deleteJsonDocument(this.credentialsFile, saveFailure)
        return
      }
      await writeFile(this.credentialsFile, previous, { flush: true })
    } catch (restoreError) {
      throw new AppException({
        code: ConnectionErrorCodes.settingsSaveFailed,
        msg: '连接设置保存失败',
        cause: new AggregateError([error, restoreError], '连接设置保存与恢复失败')
      })
    }
  }
}

/**
 * 解密后的扩展必须仍是保存时的普通对象。形状被改过按凭据损坏处理，不回显内容。
 * @throws {AppException} 内容不是对象，或 JSON 无法解析。
 */
function parseStoredExtension(value: string): ConnectionExtension {
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch (error) {
    throw new AppException({
      code: ConnectionErrorCodes.credentialStoreFailed,
      msg: '无法安全读取密钥，请重新填写',
      cause: error
    })
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed))
    throw new AppException({
      code: ConnectionErrorCodes.credentialStoreFailed,
      msg: '无法安全读取密钥，请重新填写'
    })
  return parsed as ConnectionExtension
}
