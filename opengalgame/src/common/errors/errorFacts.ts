export interface ErrorFacts {
  errorName?: string
  causeNames: string[]
  causeCodes: number[]
  statuses: number[]
}

/** 只取异常名、数字错误码和数字状态。不读取消息、堆栈或请求内容。 */
export function errorFacts(error: unknown): ErrorFacts {
  const names: string[] = []
  const codes: number[] = []
  const statuses: number[] = []
  const seen = new Set<unknown>()
  let current: unknown = error
  while (current !== undefined && current !== null && !seen.has(current)) {
    seen.add(current)
    if (typeof current !== 'object') break
    if ('name' in current && typeof current.name === 'string') names.push(current.name)
    if ('code' in current && isFiniteNumber(current.code)) codes.push(current.code)
    if ('status' in current && isFiniteNumber(current.status)) statuses.push(current.status)
    current = 'cause' in current ? current.cause : undefined
  }
  const [errorName, ...causeNames] = names
  return {
    ...(errorName ? { errorName } : {}),
    causeNames,
    causeCodes: codes.slice(1),
    statuses
  }
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}
