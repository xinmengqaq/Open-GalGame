import { AppException } from '@common/errors/AppException'
import { ProjectFileErrorCodes } from '../errors/ProjectFileErrorCodes'

/**
 * 拒绝空白名称和带目录的路径。操作系统保留名由文件适配器校验。
 * @throws {AppException} 名称空白或包含路径分隔符。
 */
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

/** 按目标位置的大小写折叠比较文件名。不使用本机语言环境。 */
export function sameFileName(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase()
}

/** 拆出最后一个扩展名。没有扩展名时 extension 为 null。 */
export function splitFileName(fileName: string): { stem: string; extension: string | null } {
  const dot = fileName.lastIndexOf('.')
  if (dot <= 0 || dot === fileName.length - 1) return { stem: fileName, extension: null }
  return { stem: fileName.slice(0, dot), extension: fileName.slice(dot) }
}
