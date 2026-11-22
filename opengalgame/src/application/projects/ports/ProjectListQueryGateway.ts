export interface ProjectRegistrationRecord {
  id: string
  directory: string
}

export interface ProjectRegistrationPageQuery {
  offset: number
  limit: number
}

export interface ProjectListQueryGateway {
  listRegistrations(query: ProjectRegistrationPageQuery): Promise<ProjectRegistrationRecord[]>

  countRegistrations(): Promise<number>

  findRegistration(id: string): Promise<ProjectRegistrationRecord | null>
}
