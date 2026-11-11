export type ProjectOperationVO =
  { status: 'cancelled' } | { status: 'completed'; projectId: string; name: string }

export type ProjectProgressVO = {
  operationId: string
  stage: 'selecting' | 'inspecting' | 'initializing' | 'registering' | 'completed'
  projectId?: string
  event?: 'created' | 'imported'
}

export type ProjectProgressListener = (progress: ProjectProgressVO) => void

export type ProjectSummaryVO = {
  id: string
  name: string
  synopsis: string
}

export type ProjectListEntryVO =
  | ({ status: 'available' } & ProjectSummaryVO)
  | { status: 'unavailable'; id: string; code: number; msg: string }

export type ProjectListPageVO = {
  entries: ProjectListEntryVO[]
  total: number
  offset: number
  limit: number
}

export type UnregisterProjectVO = {
  id: string
}

export type ProjectSaveLocationVO = {
  directory: string
}
