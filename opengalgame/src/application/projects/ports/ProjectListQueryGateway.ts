export interface ProjectRegistrationRecord {
  id: string
  directory: string
}

export interface ProjectRegistrationPageQuery {
  offset: number
  limit: number
}

export interface ProjectListQueryGateway {
  /**
   * @returns 本页登记；无记录或越界时为空数组。
   * @throws {AppException} 本机登记文件整体读取失败。
   */
  listRegistrations(query: ProjectRegistrationPageQuery): Promise<ProjectRegistrationRecord[]>

  /**
   * @returns 含不可用登记，不含新建卡。
   * @throws {AppException} 本机登记文件整体读取失败。
   */
  countRegistrations(): Promise<number>

  /**
   * @returns 未登记时为 null。
   * @throws {AppException} 本机登记文件整体读取失败。
   */
  findRegistration(id: string): Promise<ProjectRegistrationRecord | null>
}
