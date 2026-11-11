import { readFileSync } from 'node:fs'
import { z } from 'zod'

import { parseUnknownValue } from '../validation/parseUnknownValue'
import type { ConfigurationGateway } from '@common/config/ConfigurationGateway'
import { LOG_LEVELS, type RuntimeConfig } from '@common/config/RuntimeConfig'
import { AppException } from '@common/errors/AppException'

const runtimeSchema = z.strictObject({
  logLevel: z.enum(LOG_LEVELS).default('info'),
  logMaxBytes: z.coerce.number().int().min(1024).multipleOf(1024).default(1048576),
  logRetentionDays: z.coerce.number().int().positive().default(7),
  requestTimeoutMs: z.coerce.number().int().positive().max(2147483647).default(10000)
})

const environmentFields = {
  logLevel: 'OPENGALGAME_LOG_LEVEL',
  logMaxBytes: 'OPENGALGAME_LOG_MAX_BYTES',
  logRetentionDays: 'OPENGALGAME_LOG_RETENTION_DAYS',
  requestTimeoutMs: 'OPENGALGAME_REQUEST_TIMEOUT_MS'
} as const

/**
 * 读取并解析运行配置文件。文件不存在按空配置处理，其余读取或解析失败转为带码异常。
 * @returns 解析结果；文件不存在时为空对象。
 * @throws {AppException} 文件无法读取或内容不是合法 JSON。
 */
function readConfigFile(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}
    throw new AppException({ code: 5101, msg: '运行配置文件无法读取或解析', cause: error })
  }
}

/** 未设置或空白不覆盖文件取值。带首尾空白的数字不能进入数值转换。 */
function readEnvironment(environment: NodeJS.ProcessEnv): Record<string, string> {
  const fields: Record<string, string> = {}
  for (const [field, name] of Object.entries(environmentFields)) {
    const raw = environment[name]
    if (raw === undefined || raw.trim() === '') continue
    if (field !== 'logLevel' && raw !== raw.trim()) {
      throw new AppException({ code: 5101, msg: '运行配置取值无效' })
    }
    fields[field] = field === 'logLevel' ? raw.trim() : raw
  }
  return fields
}

export class FileConfigurationGatewayImpl implements ConfigurationGateway {
  private readonly snapshot: Readonly<RuntimeConfig>
  /** 按默认、文件、环境的顺序加载并校验一次运行配置。缺省项取默认值，非法取值不回落默认值。 */
  constructor(path: string, environment: NodeJS.ProcessEnv = process.env) {
    const file = parseUnknownValue(
      runtimeSchema.partial(),
      readConfigFile(path),
      5101,
      '运行配置字段或取值无效'
    )
    this.snapshot = Object.freeze(
      parseUnknownValue(
        runtimeSchema,
        { ...file, ...readEnvironment(environment) },
        5101,
        '运行配置取值无效'
      )
    )
  }
  /** 返回经过校验的不可变快照。 */
  getSnapshot(): Readonly<RuntimeConfig> {
    return this.snapshot
  }
}
