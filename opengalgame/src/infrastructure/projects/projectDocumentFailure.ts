import type { StorageFailure } from '../storage/jsonDocument'
import { ProjectErrorCodes } from '@domain/projects/errors/ProjectErrorCodes'

const diskFull = { code: ProjectErrorCodes.diskFull, msg: '磁盘空间不足' }
const notWritable = {
  code: ProjectErrorCodes.destinationNotWritable,
  msg: '保存位置不可访问或不可写'
}

/**
 * 项目文档读写失败。磁盘满与无权限仍用项目技术码，其余失败用调用方的码。
 * @param code - 其余失败的错误码。
 * @param msg - 其余失败的中文说明。
 * @returns 带磁盘满与无权限映射的失败说明。
 */
export function projectDocumentFailure(code: number, msg: string): StorageFailure {
  return { code, msg, diskFull, notWritable }
}
