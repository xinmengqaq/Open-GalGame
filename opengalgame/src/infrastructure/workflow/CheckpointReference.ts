import { AppException } from '@common/errors/AppException'
import { ErrorCodes } from '@common/errors/ErrorCodes'

export function assertRevisionToken(value: string): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{7,64}$/u.test(value)) {
    throw new AppException({ code: ErrorCodes.invalidRequest, msg: '候选修订引用无效' })
  }
  return value
}
