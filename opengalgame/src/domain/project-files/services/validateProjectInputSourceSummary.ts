import { AppException } from '@common/errors/AppException'
import { ProjectFileErrorCodes } from '../errors/ProjectFileErrorCodes'
import type { ProjectFileAssetKind, ProjectInputSourceSummary } from '../models/ProjectInputSource'

const assetKinds = new Set<ProjectFileAssetKind>(['image', 'audio', 'video'])

/**
 * 校验扫描摘要的身份、类别和文本子类型。
 * 空白名称是可识别问题，改为不可读，不让整次扫描失败。
 * 不构造正文，也不判断文件是否真实可读。
 * @returns 身份和类别成立后的摘要。空白名称标为不可读。
 * @throws {AppException} 身份为空、类别不受支持，或文本缺少子类型。
 */
export function validateProjectInputSourceSummary(
  summary: ProjectInputSourceSummary
): ProjectInputSourceSummary {
  if (typeof summary.sourceId !== 'string' || summary.sourceId.trim() === '') {
    throw new AppException({
      code: ProjectFileErrorCodes.blankSourceId,
      msg: '来源身份不能为空'
    })
  }
  if (summary.contentKind === 'text') {
    if (summary.textKind !== 'document') {
      throw new AppException({
        code: ProjectFileErrorCodes.blankSourceContent,
        msg: '文本来源子类型不受支持'
      })
    }
  } else if (!(assetKinds as ReadonlySet<string>).has(summary.contentKind)) {
    throw new AppException({
      code: ProjectFileErrorCodes.invalidAssetPurpose,
      msg: '文件类型不受支持'
    })
  }
  if (summary.readable && (typeof summary.name !== 'string' || summary.name.trim() === '')) {
    return { ...summary, readable: false }
  }
  return summary
}

/**
 * 找出出现多次的来源身份。
 * 重复项都不能当作可读取来源，调用方不得只保留其中一项。
 * @returns 重复出现的身份。
 */
export function duplicateSourceIds(sourceIds: readonly string[]): ReadonlySet<string> {
  const counts = new Map<string, number>()
  for (const sourceId of sourceIds) counts.set(sourceId, (counts.get(sourceId) ?? 0) + 1)
  const duplicates = new Set<string>()
  for (const [sourceId, count] of counts) {
    if (count > 1) duplicates.add(sourceId)
  }
  return duplicates
}
