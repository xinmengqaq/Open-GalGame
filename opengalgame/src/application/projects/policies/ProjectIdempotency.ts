import type { CreateProjectDTO } from '../dto/ProjectDTO'

/** 按明确业务字段计算新建指纹，保持已持久化指纹格式。 */
export function createProjectFingerprint(request: CreateProjectDTO): string {
  return JSON.stringify({ kind: 'create', name: request.name, synopsis: request.synopsis ?? '' })
}

/** 计算导入指纹，目录仍由首次操作的选择结果确定。 */
export function importProjectFingerprint(): string {
  return JSON.stringify({ kind: 'import' })
}
