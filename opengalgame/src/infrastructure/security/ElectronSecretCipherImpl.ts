import { ConnectionErrorCodes } from '@domain/connections/errors/ConnectionErrorCodes'
import { safeStorage } from 'electron'

import type { SecretCipher } from './SecretCipher'
import { AppException } from '@common/errors/AppException'

export class ElectronSecretCipherImpl implements SecretCipher {
  /** 使用系统保护机制加密，不允许明文降级。 */
  encrypt(value: string): Buffer {
    if (
      !safeStorage.isEncryptionAvailable() ||
      (process.platform === 'linux' && safeStorage.getSelectedStorageBackend() === 'basic_text')
    )
      throw new AppException({
        code: ConnectionErrorCodes.credentialStoreFailed,
        msg: '当前系统未提供安全的凭据存储'
      })
    return safeStorage.encryptString(value)
  }
  decrypt(value: Buffer): string {
    return safeStorage.decryptString(value)
  }
}
