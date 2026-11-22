import { AppException } from '@common/errors/AppException'
import { ProjectFileErrorCodes } from '../errors/ProjectFileErrorCodes'
import type { ProjectFileAssetKind, ProjectInputSourceSummary } from '../models/ProjectInputSource'

const assetKinds = new Set<ProjectFileAssetKind>(['image', 'audio', 'video'])

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

export function duplicateSourceIds(sourceIds: readonly string[]): ReadonlySet<string> {
  const counts = new Map<string, number>()
  for (const sourceId of sourceIds) counts.set(sourceId, (counts.get(sourceId) ?? 0) + 1)
  const duplicates = new Set<string>()
  for (const [sourceId, count] of counts) {
    if (count > 1) duplicates.add(sourceId)
  }
  return duplicates
}
