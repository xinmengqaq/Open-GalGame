import { AppException } from '@common/errors/AppException'
import { ProjectFileErrorCodes } from '../errors/ProjectFileErrorCodes'
import type { ProjectInputSource } from '../models/ProjectInputSource'
import { validateProjectInputSource } from './validateProjectInputSource'

/**
 * 校验同一读取窗口内的来源，并拒绝重复来源身份。
 * @throws {AppException} 单个来源不成立，或来源身份重复。
 */
export function validateProjectInputSources(sources: readonly ProjectInputSource[]): void {
  const seen = new Set<string>()
  for (const source of sources) {
    validateProjectInputSource(source)
    if (seen.has(source.sourceId)) {
      throw new AppException({
        code: ProjectFileErrorCodes.duplicateSourceId,
        msg: '同一次读取不能重复登记同一来源'
      })
    }
    seen.add(source.sourceId)
  }
}
