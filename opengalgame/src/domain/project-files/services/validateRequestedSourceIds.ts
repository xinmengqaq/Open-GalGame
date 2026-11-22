import { AppException } from '@common/errors/AppException'
import { ProjectFileErrorCodes } from '../errors/ProjectFileErrorCodes'

export function validateRequestedSourceIds(sourceIds: readonly string[]): void {
  if (!Array.isArray(sourceIds)) {
    throw new AppException({
      code: ProjectFileErrorCodes.blankSourceId,
      msg: '来源身份不能为空'
    })
  }
  const seen = new Set<string>()
  for (const sourceId of sourceIds) {
    if (typeof sourceId !== 'string' || sourceId.trim() === '') {
      throw new AppException({
        code: ProjectFileErrorCodes.blankSourceId,
        msg: '来源身份不能为空'
      })
    }
    if (seen.has(sourceId)) {
      throw new AppException({
        code: ProjectFileErrorCodes.duplicateSourceId,
        msg: '同一次读取不能重复请求同一来源'
      })
    }
    seen.add(sourceId)
  }
}
