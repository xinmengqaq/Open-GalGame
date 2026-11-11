export type WebgalInfrastructureErrorKind =
  | 'invalid-path'
  | 'missing-entry'
  | 'missing-file'
  | 'invalid-encoding'
  | 'inconsistent-read'
  | 'read-failed'
  | 'parse-failed'
  | 'incompatible-runtime'
  | 'preview-protocol'
  | 'preview-timeout'
  | 'preview-not-ready'
  | 'preview-no-progress'
  | 'preview-stale'
  | 'preview-cancelled'
  | 'preview-disconnected'
  | 'runtime-error'

/** WebGAL 基础设施边界的可追踪技术错误。 */
export class WebgalInfrastructureError extends Error {
  readonly name = 'WebgalInfrastructureError'

  /**
   * 构造可追踪的技术错误。类别供上层映射失败语义，路径用于定位涉及的文件。
   * @param path - 相关文件路径；不涉及文件时省略。
   */
  constructor(
    readonly kind: WebgalInfrastructureErrorKind,
    message: string,
    readonly path?: string,
    options?: ErrorOptions
  ) {
    super(message, options)
  }
}
