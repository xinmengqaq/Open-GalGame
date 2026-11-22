import type { StorageFailure } from '../storage/jsonDocument'
import { ProjectErrorCodes } from '@domain/projects/errors/ProjectErrorCodes'

const diskFull = { code: ProjectErrorCodes.diskFull, msg: '磁盘空间不足' }
const notWritable = {
  code: ProjectErrorCodes.destinationNotWritable,
  msg: '保存位置不可访问或不可写'
}

export function projectDocumentFailure(code: number, msg: string): StorageFailure {
  return { code, msg, diskFull, notWritable }
}
