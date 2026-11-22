export type ProjectFileDiagnosticKind =
  'missing' | 'damaged' | 'duplicateIdentity' | 'brokenReference'

export type ProjectFileDiagnosticVO = {
  objectId: string
  kind: ProjectFileDiagnosticKind
}

export type ProjectFilesInspectionVO = {
  projectId: string
  inputSourceFormatSupported: boolean
  canvasArrangementFormatSupported: boolean
  diagnostics: readonly ProjectFileDiagnosticVO[]
}
