import { z } from 'zod'

import type { UpdateInstallAttemptGateway } from '@application/app-update/ports/UpdateInstallAttemptGateway'
import { ErrorCodes } from '@common/errors/ErrorCodes'
import { APP_VERSION_PATTERN } from '@domain/app-update/models/AppVersion'
import type { UpdateInstallAttempt } from '@domain/app-update/models/InstallAttempt'

import {
  deleteJsonDocument,
  readJsonDocument,
  writeJsonDocument,
  type StorageFailure
} from '../storage/jsonDocument'
import { parseUnknownValue } from '../validation/parseUnknownValue'

const INSTALL_ATTEMPT_FILE_FORMAT_VERSION = 1
const failure: StorageFailure = { code: ErrorCodes.internalError, msg: '更新安装记录读写失败' }
const corruptedMessage = '更新安装记录损坏，请重新更新'

const installAttemptDocumentSchema = z.strictObject({
  formatVersion: z.literal(INSTALL_ATTEMPT_FILE_FORMAT_VERSION),
  fromVersion: z.string().regex(APP_VERSION_PATTERN),
  toVersion: z.string().regex(APP_VERSION_PATTERN),
  attemptedAt: z.string().min(1)
})

/** 把安装尝试写入应用 userData，文件损坏或缺失都不影响其他用户数据。 */
export class UserDataInstallAttemptGatewayImpl implements UpdateInstallAttemptGateway {
  constructor(private readonly filePath: string) {}

  async read(): Promise<UpdateInstallAttempt | null> {
    const value = await readJsonDocument(this.filePath, failure)
    if (value === null) return null
    const document = parseUnknownValue(
      installAttemptDocumentSchema,
      value,
      failure.code,
      corruptedMessage
    )
    return {
      fromVersion: document.fromVersion,
      toVersion: document.toVersion,
      attemptedAt: document.attemptedAt
    }
  }

  async record(attempt: UpdateInstallAttempt): Promise<void> {
    await writeJsonDocument(
      this.filePath,
      {
        formatVersion: INSTALL_ATTEMPT_FILE_FORMAT_VERSION,
        fromVersion: attempt.fromVersion,
        toVersion: attempt.toVersion,
        attemptedAt: attempt.attemptedAt
      },
      failure
    )
  }

  async clear(): Promise<void> {
    await deleteJsonDocument(this.filePath, failure)
  }
}
