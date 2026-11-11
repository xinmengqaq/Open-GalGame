/** 可识别的工程文件问题。不使用独立诊断码。 */
export type ProjectFileDiagnosticKind =
  'missing' | 'damaged' | 'duplicateIdentity' | 'brokenReference'

export type ProjectFileDiagnosticVO = {
  /** 出现问题的来源、卡片或编排对象身份。 */
  objectId: string
  kind: ProjectFileDiagnosticKind
}

export type ProjectFilesInspectionVO = {
  projectId: string
  inputSourceFormatSupported: boolean
  canvasArrangementFormatSupported: boolean
  diagnostics: readonly ProjectFileDiagnosticVO[]
}
