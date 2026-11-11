import { describe, expect, it } from 'vitest'

import type { ProjectVersioningApplicationService } from '@application/project-versioning/services/ProjectVersioningApplicationService'
import type { VersionSettlementVO } from '@application/project-versioning/vo/ProjectVersioningVO'
import { LocalProjectWorkVersionGatewayImpl } from '@infrastructure/project-files/LocalProjectWorkVersionGatewayImpl'

const project = { projectId: 'project-1', location: { directory: 'D:/works/project-1' } }

function gateway(settlement: VersionSettlementVO): LocalProjectWorkVersionGatewayImpl {
  const versioning = {
    readCallerOperation: async () => ({
      projectId: project.projectId,
      sourceModule: 'project-files',
      callerOperationId: 'op-1',
      operationId: 'version-op-1'
    }),
    readOperationSettlement: async () => ({ ...settlement, operationId: 'version-op-1' })
  } as ProjectVersioningApplicationService
  return new LocalProjectWorkVersionGatewayImpl(versioning, async () => 'catalog-v1')
}

describe('工程文件操作事实', () => {
  it('只把确定成功和确定未提交当成可以放开的事实', async () => {
    await expect(
      gateway({ operationId: 'op-1', state: '已提交', revisionRef: 'rev-1' }).readOperation(
        project,
        'op-1'
      )
    ).resolves.toBe('committed')
    await expect(
      gateway({ operationId: 'op-1', state: '无变更', revisionRef: 'rev-1' }).readOperation(
        project,
        'op-1'
      )
    ).resolves.toBe('committed')
    await expect(
      gateway({ operationId: 'op-1', state: '未提交' }).readOperation(project, 'op-1')
    ).resolves.toBe('notCommitted')
    await expect(
      gateway({ operationId: 'op-1', state: '待核对' }).readOperation(project, 'op-1')
    ).resolves.toBe('unsettled')
    await expect(
      gateway({ operationId: 'op-1', state: '待回退', revisionRef: 'rev-1' }).readOperation(
        project,
        'op-1'
      )
    ).resolves.toBe('unsettled')
    await expect(
      gateway({
        operationId: 'op-1',
        state: '已回退',
        originalRevisionRef: 'rev-0',
        revisionRef: 'rev-1'
      }).readOperation(project, 'op-1')
    ).resolves.toBe('unsettled')
  })
})
