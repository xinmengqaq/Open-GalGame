/** 契约层的更新生命周期。与领域层保持同一组取值，但按分层边界独立声明。 */
export type UpdatePhase =
  'idle' | 'checking' | 'available' | 'downloading' | 'downloaded' | 'installing' | 'failed'

/** 契约层的失败分类。与领域层保持同一组取值，但按分层边界独立声明。 */
export type UpdateFailureKind =
  'unsupported' | 'source-unavailable' | 'download-failed' | 'install-failed' | 'invalid-state'

/** 发布源摘要。发行说明是纯文本，不携带原始 HTML。 */
export type ReleaseSummaryVO = {
  version: string
  releaseName?: string
  releaseNotes?: string
  releasedAt?: string
}

/** 下载进度。total 不大于 0 表示总量未知，percent 固定为 0。 */
export type UpdateProgressVO = {
  percent: number
  transferred: number
  total: number
  bytesPerSecond: number
}

/** 可展示的失败。message 已经过安全映射，不含原始异常文本。 */
export type UpdateFailureVO = {
  kind: UpdateFailureKind
  message: string
}

/** 当前更新状态。缺省的可选字段表示该阶段没有对应事实。 */
export type UpdateStatusVO = {
  phase: UpdatePhase
  currentVersion: string
  supported: boolean
  release?: ReleaseSummaryVO
  progress?: UpdateProgressVO
  failure?: UpdateFailureVO
}

/** 一次检查的结果。只有确认存在严格更新时才携带 release。 */
export type UpdateCheckVO = {
  phase: 'available' | 'idle'
  currentVersion: string
  release?: ReleaseSummaryVO
}
