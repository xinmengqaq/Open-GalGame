import { AppException } from '@common/errors/AppException'
import { ProjectFileErrorCodes } from '../errors/ProjectFileErrorCodes'
import { requireSingleFileName, sameFileName, splitFileName } from './fileNameFacts'

const MAX_IMPORT_SUFFIX = 9999

/**
 * 根据原名称和名称占用事实选择导入名称。
 * 原名称未占用时直接使用。同名时在扩展名前依次追加序号，不覆盖已有文件。
 * 名称比较不区分大小写，以匹配桌面目标位置的文件名折叠。
 * @param originalFileName - 用户选择的原文件名，不含目录。
 * @throws {AppException} 文件名无效，或序号用尽仍全部占用。
 */
export function chooseImportFileName(
  originalFileName: string,
  occupiedNames: readonly string[]
): string {
  requireSingleFileName(originalFileName)
  if (!occupiedNames.some((name) => sameFileName(name, originalFileName))) return originalFileName
  const { stem, extension } = splitFileName(originalFileName)
  const suffix = extension ?? ''
  for (let index = 1; index <= MAX_IMPORT_SUFFIX; index += 1) {
    const candidate = `${stem} (${index})${suffix}`
    if (!occupiedNames.some((name) => sameFileName(name, candidate))) return candidate
  }
  throw new AppException({
    code: ProjectFileErrorCodes.importNameExhausted,
    msg: '没有可用的导入文件名'
  })
}
