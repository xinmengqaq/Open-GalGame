import { AppException } from '@common/errors/AppException'
import { ProjectFileErrorCodes } from '../errors/ProjectFileErrorCodes'
import { requireSingleFileName, sameFileName, splitFileName } from './fileNameFacts'

const MAX_IMPORT_SUFFIX = 9999

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
