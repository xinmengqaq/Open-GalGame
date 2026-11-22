export const APP_VERSION_PATTERN = /^(\d+)\.(\d+)\.(\d+)$/

export class InvalidAppVersionError extends Error {
  constructor() {
    super('应用版本号必须是三段非负整数')
    this.name = 'InvalidAppVersionError'
  }
}

export function compareAppVersion(current: string, candidate: string): -1 | 0 | 1 {
  const currentSegments = parseVersionSegments(current)
  const candidateSegments = parseVersionSegments(candidate)
  for (let index = 0; index < currentSegments.length; index += 1) {
    const result = compareSegments(currentSegments[index], candidateSegments[index])
    if (result !== 0) return result
  }
  return 0
}

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
