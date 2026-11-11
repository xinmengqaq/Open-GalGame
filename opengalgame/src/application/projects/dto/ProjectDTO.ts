export type CreateProjectDTO = {
  operationId: string
  name: string
  synopsis?: string
}

export type ImportProjectDTO = {
  operationId: string
}

export type ListProjectsDTO = {
  offset: number
  limit: number
}

export type OpenProjectDTO = {
  id: string
}

export type RenameProjectDTO = {
  id: string
  name: string
  synopsis?: string
}

export type UnregisterProjectDTO = {
  id: string
}
