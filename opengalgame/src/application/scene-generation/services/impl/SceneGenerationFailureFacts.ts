import { AppException } from '@common/errors/AppException'
import type { ErrorFacts } from '@common/errors/errorFacts'
import {
  analyzeSceneGenerationFailure,
  nestedFailureCauses,
  safeFailure,
  type SceneGenerationFailureCandidateFacts,
  type SceneGenerationFailureFact
} from '../../models/SceneGenerationFailureFacts'

export { FAILURE_CAUSE_NAME } from '../../models/SceneGenerationFailureFacts'

/** 返回诊断编号的事实载荷。哈希由持有 node:crypto 的边界完成。 */
export function diagnosticFactPayload(
  facts: ErrorFacts,
  category?: AppException['diagnosticCategory']
): string | undefined {
  if (
    !facts.errorName &&
    facts.causeNames.length === 0 &&
    facts.causeCodes.length === 0 &&
    facts.statuses.length === 0 &&
    !category
  ) {
    return undefined
  }
  return JSON.stringify({
    errorName: facts.errorName,
    causeNames: facts.causeNames,
    causeCodes: facts.causeCodes,
    statuses: facts.statuses,
    category
  })
}

/**
 * 诊断边界构建失败事实：一次分析后计算诊断编号，再交给纯事实组装。
 * hash/config 只存在于本模块；调用方不重复遍历异常链。
 */
export function safeFailureWithDiagnosticRef(
  error: unknown,
  candidate?: SceneGenerationFailureCandidateFacts
): SceneGenerationFailureFact {
  const analysis = analyzeSceneGenerationFailure(error)
  const payload = diagnosticFactPayload(analysis.facts, analysis.category)
  const diagnosticRef = payload && diagnosticHash ? diagnosticHash(payload) : undefined
  return safeFailure(error, analysis, candidate, diagnosticRef)
}

/** 在包装异常里找到实际持久化的项目异常，保证日志编号与执行记录相同。 */
export function recordedFailureOf(error: unknown): SceneGenerationFailureFact | undefined {
  const seen = new Set<unknown>()
  const queue: unknown[] = nestedFailureCauses(error)
  let recorded: SceneGenerationFailureFact | undefined
  while (queue.length > 0) {
    const current = queue.shift()
    if (current === undefined || current === null || seen.has(current)) continue
    seen.add(current)
    if (typeof current !== 'object') continue
    if (current instanceof AppException && !recorded)
      recorded = safeFailureWithDiagnosticRef(current)
    queue.push(...nestedFailureCauses(current))
  }
  return recorded
}

let diagnosticHash: ((payload: string) => string) | undefined

export function configureDiagnosticHash(hash: (payload: string) => string): void {
  diagnosticHash = hash
}
