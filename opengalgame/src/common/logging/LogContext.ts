export interface LogContext {
  requestId?: string
  operationId?: string
  projectId?: string
  stage?: string
  errorCode?: number
  errorName?: string
  causeNames?: string
  causeCodes?: string
  statuses?: string
  diagnosticRef?: string
  category?: string
  recordedDiagnosticRef?: string
  recordedCategory?: string
  durationMs?: number
}
