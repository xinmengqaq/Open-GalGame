import { AppException } from '@common/errors/AppException'
import { ProjectFileErrorCodes } from '../errors/ProjectFileErrorCodes'

export function requireSingleFileName(fileName: string): void {
  if (
    typeof fileName !== 'string' ||
    fileName.trim() === '' ||
    fileName === '.' ||
    fileName === '..' ||
    fileName.includes('/') ||
    fileName.includes('\\') ||
    fileName.includes('\0')
  ) {
    throw new AppException({
      code: ProjectFileErrorCodes.invalidFileName,
      msg: '文件名无效'
    })
  }
}

export function sameFileName(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase()
}

export function splitFileName(fileName: string): { stem: string; extension: string | null } {
  const dot = fileName.lastIndexOf('.')
  if (dot <= 0 || dot === fileName.length - 1) return { stem: fileName, extension: null }
  return { stem: fileName.slice(0, dot), extension: fileName.slice(dot) }
}
