import type { ProjectBaselineGateway } from '@application/projects/ports/ProjectBaselineGateway'
import type { VersionTransactionGateway } from '@application/project-versioning/ports/VersionTransactionGateway'

/**
 * 把工程声明路径交给版本事务。
 * 不读取文件内容，也不把 Git 事实返回给应用层。
 */
export class LocalProjectBaselineGatewayImpl implements ProjectBaselineGateway {
  constructor(private readonly transactions: VersionTransactionGateway) {}

  ensureDeclaredPaths(projectId: string, paths: readonly string[]): Promise<void> {
    return this.transactions
      .ensureDeclaredPaths({ projectId, paths: [...paths] })
      .then(() => undefined)
  }

  inspectDeclaredPaths(projectId: string, paths: readonly string[]): Promise<boolean> {
    return this.transactions.inspectDeclaredPaths({ projectId, paths: [...paths] })
  }
}
