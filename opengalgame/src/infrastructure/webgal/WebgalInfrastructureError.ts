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

export class WebgalInfrastructureError extends Error {
  readonly name = 'WebgalInfrastructureError'

  constructor(
    readonly kind: WebgalInfrastructureErrorKind,
    message: string,
    readonly path?: string,
    options?: ErrorOptions
  ) {
    super(message, options)
  }
}
