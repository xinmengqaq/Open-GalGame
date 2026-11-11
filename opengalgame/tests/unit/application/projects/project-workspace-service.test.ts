import { describe, expect, it, vi } from 'vitest'

import { ProjectWorkspaceServiceImpl } from '@application/projects/services/impl/ProjectWorkspaceServiceImpl'
import type { ProjectBaselineGateway } from '@application/projects/ports/ProjectBaselineGateway'
import type { ProjectSceneIdentityGateway } from '@application/projects/ports/ProjectSceneIdentityGateway'
import type { ProjectSceneSeedGateway } from '@application/projects/ports/ProjectSceneSeedGateway'
import { AppException } from '@common/errors/AppException'
import { ProjectErrorCodes } from '@domain/projects/errors/ProjectErrorCodes'

const IDENTITY = { sceneId: 'scene-1', canvasId: 'canvas-1' }
const DECLARED = [
  '.opengalgame/project.json',
  '.opengalgame/manifest.json',
  'game/scene/start.txt',
  '.opengalgame/scene-locks.json'
]

function service(overrides?: {
  identity?: Partial<ProjectSceneIdentityGateway>
  seeds?: Partial<ProjectSceneSeedGateway>
  baseline?: Partial<ProjectBaselineGateway>
}): {
  workspace: ProjectWorkspaceServiceImpl
  identity: ProjectSceneIdentityGateway
  seeds: ProjectSceneSeedGateway
  baseline: ProjectBaselineGateway
} {
  const identity: ProjectSceneIdentityGateway = {
    ensureIdentity: vi.fn(async () => IDENTITY),
    readIdentity: vi.fn(async () => IDENTITY),
    ...overrides?.identity
  }
  const seeds: ProjectSceneSeedGateway = {
    ensureSceneFiles: vi.fn(async () => undefined),
    inspectSceneFiles: vi.fn(async () => true),
    ...overrides?.seeds
  }
  const baseline: ProjectBaselineGateway = {
    ensureDeclaredPaths: vi.fn(async () => undefined),
    inspectDeclaredPaths: vi.fn(async () => true),
    ...overrides?.baseline
  }
  return {
    workspace: new ProjectWorkspaceServiceImpl({ identity, seeds, baseline }),
    identity,
    seeds,
    baseline
  }
}

describe('ProjectWorkspaceService', () => {
  it('按持久身份核对场景文件和声明路径', async () => {
    const { workspace, identity, seeds, baseline } = service()
    await expect(workspace.ensureProjectWorkspace({ projectId: 'project-1' })).resolves.toEqual({
      projectId: 'project-1',
      ...IDENTITY
    })
    expect(identity.ensureIdentity).toHaveBeenCalledWith('project-1')
    expect(seeds.ensureSceneFiles).toHaveBeenCalledWith('project-1', 'scene-1')
    expect(baseline.ensureDeclaredPaths).toHaveBeenCalledWith('project-1', DECLARED)
  })

  it('重复调用仍走同一幂等端口，不改写返回身份', async () => {
    const { workspace } = service()
    const first = await workspace.ensureProjectWorkspace({ projectId: 'project-1' })
    const second = await workspace.ensureProjectWorkspace({ projectId: 'project-1' })
    expect(second).toEqual(first)
  })

  it('身份、场景或基线失败都变成不含内部细节的初始化失败', async () => {
    const secret = 'D:/story/.git/fatal locked'
    const failures = [
      service({
        identity: {
          ensureIdentity: vi.fn(async () => {
            throw new Error(secret)
          })
        }
      }),
      service({
        seeds: {
          ensureSceneFiles: vi.fn(async () => {
            throw new AppException({ code: 1203, msg: secret })
          })
        }
      }),
      service({
        baseline: {
          ensureDeclaredPaths: vi.fn(async () => {
            throw new Error(secret)
          })
        }
      })
    ]
    for (const { workspace, seeds, baseline } of failures) {
      const error = await workspace.ensureProjectWorkspace({ projectId: 'project-1' }).then(
        () => null,
        (caught: unknown) => caught
      )
      expect(error).toBeInstanceOf(AppException)
      expect(error).toMatchObject({
        code: ProjectErrorCodes.workspaceNotReady,
        message: '工程初始化未完成，请重新构建'
      })
      expect((error as AppException).message).not.toContain(secret)
      expect((error as AppException).message).not.toContain('.git')
      const seedOrder = seeds.ensureSceneFiles.mock.invocationCallOrder[0]
      const baselineOrder = baseline.ensureDeclaredPaths.mock.invocationCallOrder[0]
      if (seedOrder !== undefined && baselineOrder !== undefined) {
        expect(seedOrder).toBeLessThan(baselineOrder)
      }
    }
  })

  it('检查就绪时不调用补建端口', async () => {
    const { workspace, identity, seeds, baseline } = service()
    await expect(workspace.inspectProjectWorkspace({ projectId: 'project-1' })).resolves.toEqual({
      ready: true,
      ...IDENTITY
    })
    expect(identity.ensureIdentity).not.toHaveBeenCalled()
    expect(seeds.ensureSceneFiles).not.toHaveBeenCalled()
    expect(baseline.ensureDeclaredPaths).not.toHaveBeenCalled()
    expect(identity.readIdentity).toHaveBeenCalledWith('project-1')
  })

  it('场景或基线不齐时返回身份且不补建', async () => {
    const missingFile = service({
      seeds: { inspectSceneFiles: vi.fn(async () => false) }
    })
    await expect(
      missingFile.workspace.inspectProjectWorkspace({ projectId: 'project-1' })
    ).resolves.toEqual({ ready: false, ...IDENTITY })
    expect(missingFile.seeds.ensureSceneFiles).not.toHaveBeenCalled()
    expect(missingFile.baseline.ensureDeclaredPaths).not.toHaveBeenCalled()

    const missingBaseline = service({
      baseline: { inspectDeclaredPaths: vi.fn(async () => false) }
    })
    await expect(
      missingBaseline.workspace.inspectProjectWorkspace({ projectId: 'project-1' })
    ).resolves.toEqual({ ready: false, ...IDENTITY })
    expect(missingBaseline.baseline.ensureDeclaredPaths).not.toHaveBeenCalled()
  })

  it('还没有画布身份时不返回身份，也不补建', async () => {
    const { workspace, identity, seeds, baseline } = service({
      identity: { readIdentity: vi.fn(async () => null) }
    })
    await expect(workspace.inspectProjectWorkspace({ projectId: 'project-1' })).resolves.toEqual({
      ready: false
    })
    expect(identity.ensureIdentity).not.toHaveBeenCalled()
    expect(seeds.inspectSceneFiles).not.toHaveBeenCalled()
    expect(baseline.inspectDeclaredPaths).not.toHaveBeenCalled()
  })

  it('检查失败不泄露内部细节', async () => {
    const secret = 'D:/secret/.git fatal'
    const { workspace } = service({
      identity: {
        readIdentity: vi.fn(async () => {
          throw new Error(secret)
        })
      }
    })
    const error = await workspace.inspectProjectWorkspace({ projectId: 'project-1' }).then(
      () => null,
      (caught: unknown) => caught
    )
    expect(error).toMatchObject({
      code: ProjectErrorCodes.workspaceNotReady,
      message: '工程初始化未完成，请重新构建'
    })
    expect((error as AppException).message).not.toContain(secret)
    expect((error as AppException).message).not.toContain('.git')
  })
})
