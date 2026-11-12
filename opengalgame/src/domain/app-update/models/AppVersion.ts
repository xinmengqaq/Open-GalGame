export const APP_VERSION_PATTERN = /^(\d+)\.(\d+)\.(\d+)$/

export class InvalidAppVersionError extends Error {
  constructor() {
    super('应用版本号必须是三段非负整数')
    this.name = 'InvalidAppVersionError'
  }
}

/**
 * 比较三段式应用版本。
 * 只接受非负整数段，不支持预发布标记或构建元数据；参数非法时抛出，不把未知格式当成相等。
 * @returns current 小于 candidate 为 -1，相等为 0，大于为 1。
 * @throws {InvalidAppVersionError} 任一侧不是三段非负整数。
 */
export function compareAppVersion(current: string, candidate: string): -1 | 0 | 1 {
  const currentSegments = parseVersionSegments(current)
  const candidateSegments = parseVersionSegments(candidate)
  for (let index = 0; index < currentSegments.length; index += 1) {
    const result = compareSegments(currentSegments[index], candidateSegments[index])
    if (result !== 0) return result
  }
  return 0
}

/** 去掉前导零后按位数和字典序比较，避免超出安全整数范围的版本段失真。 */
function parseVersionSegments(version: string): [string, string, string] {
  const match = APP_VERSION_PATTERN.exec(version)
  if (!match) throw new InvalidAppVersionError()
  return [normalizeSegment(match[1]), normalizeSegment(match[2]), normalizeSegment(match[3])]
}

function normalizeSegment(segment: string): string {
  return segment.replace(/^0+(?=\d)/, '')
}

function compareSegments(current: string, candidate: string): -1 | 0 | 1 {
  if (current.length !== candidate.length) return current.length < candidate.length ? -1 : 1
  if (current === candidate) return 0
  return current < candidate ? -1 : 1
}
