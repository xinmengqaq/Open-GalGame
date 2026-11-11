import type {
  SceneValidationIssue,
  SceneValidationReport
} from '@domain/scene-generation/models/SceneValidationReport'
import { neutralSceneAssetReference } from '@infrastructure/webgal/assetPath'

/** 增强诊断只依赖素材名称与工程相对路径，不保存完整编排输入。 */
export type MissingAssetDiagnosticsAsset = {
  readonly name: string
  readonly relativePath: string
}

type ReferenceCandidate = {
  readonly commandReference: string
  readonly asset: MissingAssetDiagnosticsAsset
}

type CandidateMetrics = {
  readonly normalizedDistance: number
  readonly prefix: number
  readonly suffix: number
}

/**
 * 给缺失素材问题补出候选实际引用、入口行号与最近似有效引用。
 * 输入问题需已带 `reference`、`line`（由生成读取链解析）；这里只做确定性比对。
 * 无候选素材时保留原问题，不补造 nearest 字段。旧报告字段缺失时原样返回。
 * @param report - 领域校验报告。
 * @param assets - 本次操作登记的素材，用于生成有效命令引用集合。
 * @returns 带最近似引用的报告；没有可增强的问题时返回原对象。
 */
export function enrichMissingAssetDiagnostics(
  report: SceneValidationReport,
  assets: readonly MissingAssetDiagnosticsAsset[]
): SceneValidationReport {
  // 比对集合来自完整素材登记，因此必须在能拿到 relativePath 的基础设施层生成。
  const candidates: readonly ReferenceCandidate[] = assets.map((asset) => ({
    commandReference: neutralSceneAssetReference(asset.relativePath),
    asset
  }))
  const nearestByReference = new Map<string, ReferenceCandidate | undefined>()
  let changed = false
  const issues = report.issues.map((issue) => {
    if (issue.code !== 'missing-asset' || issue.reference === undefined) return issue
    if (!nearestByReference.has(issue.reference)) {
      nearestByReference.set(issue.reference, nearestCandidate(issue.reference, candidates))
    }
    const nearest = nearestByReference.get(issue.reference)
    if (nearest === undefined) return issue
    changed = true
    return {
      ...issue,
      nearestReference: nearest.commandReference,
      nearestAssetName: nearest.asset.name,
      nearestAssetPath: nearest.asset.relativePath
    } satisfies SceneValidationIssue
  })
  return changed ? { ...report, issues } : report
}

/**
 * 按归一化编辑距离取最近似引用；距离并列时比较公共前缀，再比较公共后缀。
 * 仍并列时保留素材清单中的先后顺序，保证同一输入每次得到同一结果。
 */
function nearestCandidate(
  reference: string,
  candidates: readonly ReferenceCandidate[]
): ReferenceCandidate | undefined {
  let best: ReferenceCandidate | undefined
  let bestMetrics: CandidateMetrics | undefined
  for (const candidate of candidates) {
    const metrics = metricsOf(reference, candidate.commandReference)
    if (best === undefined || bestMetrics === undefined || isCloser(metrics, bestMetrics)) {
      best = candidate
      bestMetrics = metrics
    }
  }
  return best
}

function isCloser(left: CandidateMetrics, right: CandidateMetrics): boolean {
  if (left.normalizedDistance !== right.normalizedDistance)
    return left.normalizedDistance < right.normalizedDistance
  if (left.prefix !== right.prefix) return left.prefix > right.prefix
  return left.suffix > right.suffix
}

function metricsOf(left: string, right: string): CandidateMetrics {
  return {
    normalizedDistance: editDistance(left, right) / Math.max(left.length, right.length, 1),
    prefix: commonPrefixLength(left, right),
    suffix: commonSuffixLength(left, right)
  }
}

/** 只用一个滚动行计算 Levenshtein 距离；引用长度有限，不需要更复杂的近似。 */
function editDistance(left: string, right: string): number {
  if (left === right) return 0
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index)
  for (let row = 1; row <= left.length; row += 1) {
    const current = new Array<number>(right.length + 1)
    current[0] = row
    for (let column = 1; column <= right.length; column += 1) {
      const substitution = previous[column - 1]! + (left[row - 1] === right[column - 1] ? 0 : 1)
      current[column] = Math.min(previous[column]! + 1, current[column - 1]! + 1, substitution)
    }
    previous = current
  }
  return previous[right.length]!
}

function commonPrefixLength(left: string, right: string): number {
  const limit = Math.min(left.length, right.length)
  let index = 0
  while (index < limit && left[index] === right[index]) index += 1
  return index
}

function commonSuffixLength(left: string, right: string): number {
  const limit = Math.min(left.length, right.length)
  let index = 0
  while (index < limit && left[left.length - 1 - index] === right[right.length - 1 - index])
    index += 1
  return index
}
