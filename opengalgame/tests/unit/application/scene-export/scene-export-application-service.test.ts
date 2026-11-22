import { describe, expect, it, vi } from 'vitest'

import type { SceneExportDestinationDTO } from '@application/scene-export/dto/ExportSavedSceneDTO'
import type {
  SceneExportDestination,
  SceneExportDestinationGateway
} from '@application/scene-export/ports/SceneExportDestinationGateway'
import type { SceneExportContentBasis } from '@application/scene-export/vo/SceneExportContentBasis'
import type {
  SavedSceneExportSource,
  SceneExportSourceGateway
} from '@application/scene-export/ports/SceneExportSourceGateway'
import type {
  WindowsScenePackageResult,
  WindowsScenePackager
} from '@application/scene-export/ports/WindowsScenePackager'
import type { WindowsScenePackageVO } from '@application/scene-export/vo/SceneExportVO'
import { ExportSavedScene } from '@application/scene-export/services/impl/ExportSavedScene'
import { AppException } from '@common/errors/AppException'
import { SceneExportErrorCodes } from '@domain/scene-export/errors/SceneExportErrorCodes'

const basis: SceneExportContentBasis = {
  digest: 'digest-1',
  parserVersion: '4.6.5',
  engineVersion: '4.6.5'
}
const scene = { projectId: 'project-1', sceneId: 'scene-1' }
const request = {
  ...scene,
  contentBasis: basis,
  versionReference: { kind: 'preview-save' as const, requestId: 'request-1' }
}
const saved: SavedSceneExportSource = {
  scene,
  contentBasis: basis,
  versionReference: { kind: 'preview-save', requestId: 'request-1' },
  entryRelativePath: 'game/scene/start.txt',
  entrySha256: 'a'.repeat(64),
  sceneText: '小明:已保存的一句;',
  referencedAssets: [{ sourcePath: 'game/figure/hero.png', packagePath: 'game/figure/hero.png' }]
}
const workspaceDestination: SceneExportDestination = {
  kind: 'workspace',
  parentDirectory: 'D:/projects/exported-project/exports',
  projectRoot: 'D:/projects/exported-project'
}
const selectedDestination: SceneExportDestination = {
  kind: 'selected',
  parentDirectory: 'D:/chosen-parent',
  projectRoot: 'D:/projects/exported-project'
}
const selectionId = '00000000-0000-4000-8000-000000000000'

describe('单场景 Windows 导出编排', () => {
  it('保存未成功时不调用目的地解析或打包', async () => {
    let packaged = 0
    let resolved = 0
    const service = new ExportSavedScene({
      sources: sources(async () => {
        throw new AppException({
          code: SceneExportErrorCodes.saveNotCommitted,
          msg: '当前场景还没有保存成功，不能导出'
        })
      }),
      destinations: destinations(async () => {
        resolved += 1
        return workspaceDestination
      }),
      packager: packager({
        async packageWindowsScene() {
          packaged += 1
          return unavailable()
        }
      })
    })

    await expect(service.exportSavedScene(request)).rejects.toMatchObject({
      code: SceneExportErrorCodes.saveNotCommitted
    })
    expect(resolved).toBe(0)
    expect(packaged).toBe(0)
  })

  it('草稿、候选、路径和额外目的地字段在读取已保存内容前拒绝', async () => {
    let reads = 0
    const service = serviceWith(async () => {
      reads += 1
      return saved
    })

    await expect(
      service.exportSavedScene({ ...request, candidateSnapshotId: 'candidate-1' } as never)
    ).rejects.toMatchObject({ code: SceneExportErrorCodes.exportInputRejected })
    await expect(
      service.exportSavedScene({ ...request, draftText: '未保存' } as never)
    ).rejects.toMatchObject({ code: SceneExportErrorCodes.exportInputRejected })
    await expect(
      service.exportSavedScene({ ...request, outputPath: 'D:/outside' } as never)
    ).rejects.toMatchObject({ code: SceneExportErrorCodes.exportInputRejected })
    await expect(
      service.exportSavedScene({
        ...request,
        destination: { kind: 'selected', selectionId, path: 'D:/outside' }
      } as never)
    ).rejects.toMatchObject({ code: SceneExportErrorCodes.exportInputRejected })
    expect(reads).toBe(0)
  })

  it('内容依据版本不是已审计的 4.6.5 时拒绝，且不读取保存内容或调用打包', async () => {
    let reads = 0
    let packaged = 0
    const service = serviceWith(
      async () => {
        reads += 1
        return saved
      },
      undefined,
      async () => {
        packaged += 1
        return unavailable()
      }
    )
    const failures: AppException[] = []
    for (const contentBasis of [
      { ...basis, parserVersion: '4.6.4' },
      { ...basis, engineVersion: '4.6.6' }
    ]) {
      try {
        await service.exportSavedScene({ ...request, contentBasis })
      } catch (error) {
        failures.push(error as AppException)
      }
    }
    expect(failures.map(({ code, message }) => ({ code, message }))).toEqual([
      {
        code: 4601,
        message: '导出只接受已保存的当前场景'
      },
      {
        code: 4601,
        message: '导出只接受已保存的当前场景'
      }
    ])
    expect(reads).toBe(0)
    expect(packaged).toBe(0)
  })

  it('没有可运行 Windows 产物时返回能力不可用，不返回成功', async () => {
    const service = serviceWith(
      async () => saved,
      undefined,
      async () => unavailable()
    )
    await expect(service.exportSavedScene(request)).resolves.toEqual({
      status: 'unavailable',
      reason: 'windowsPackagerUnavailable',
      message: '当前没有可调用的 Windows 桌面打包入口'
    })
  })

  it('缺省目的地按工程默认位置解析，并把目的地交给打包器', async () => {
    let resolvedIntent: SceneExportDestinationDTO | undefined
    let received: SceneExportDestination | null = null
    const artifact = artifactOf(workspaceDestination)
    const service = serviceWith(
      async () => saved,
      async (intent) => {
        resolvedIntent = intent
        return workspaceDestination
      },
      async (_input, destination) => {
        received = destination
        return { status: 'succeeded', artifact }
      }
    )

    await expect(service.exportSavedScene(request)).resolves.toEqual({
      status: 'succeeded',
      artifact
    })
    expect(resolvedIntent).toEqual({ kind: 'workspace' })
    expect(received).toEqual(workspaceDestination)
    expect(artifact.directoryPath).toMatch(/exports[\\/]scene-[a-f0-9]{16}$/u)
  })

  it('显式选择只传 selectionId，由主进程解析目的地', async () => {
    let resolvedIntent: SceneExportDestinationDTO | undefined
    const service = serviceWith(
      async () => saved,
      async (intent) => {
        resolvedIntent = intent
        return selectedDestination
      }
    )
    await service.exportSavedScene({
      ...request,
      destination: { kind: 'selected', selectionId }
    })
    expect(resolvedIntent).toEqual({ kind: 'selected', selectionId })
  })

  it('同一已保存依据同一目的地重复导出复用原结果，不再次打包', async () => {
    let packaged = 0
    const artifact = artifactOf(workspaceDestination)
    const service = serviceWith(
      async () => saved,
      undefined,
      async () => {
        packaged += 1
        return { status: 'succeeded' as const, artifact }
      }
    )

    const first = await service.exportSavedScene(request)
    const second = await service.exportSavedScene(request)
    expect(first).toEqual({ status: 'succeeded', artifact })
    expect(second).toEqual(first)
    expect(packaged).toBe(1)
  })

  it('缓存命中但产物已被删除时重新打包，不返回过期成功', async () => {
    let packaged = 0
    let valid = true
    const artifact = artifactOf(workspaceDestination)
    const service = serviceWith(
      async () => saved,
      undefined,
      async () => {
        packaged += 1
        return { status: 'succeeded' as const, artifact }
      },
      async () => valid
    )

    await service.exportSavedScene(request)
    valid = false
    await service.exportSavedScene(request)
    expect(packaged).toBe(2)
  })

  it('同一身份并发导出只打包一次，两个请求得到同一产物', async () => {
    let packaged = 0
    const readGate = Promise.withResolvers<void>()
    const artifact = artifactOf(workspaceDestination)
    const service = serviceWith(
      async () => {
        await readGate.promise
        return saved
      },
      undefined,
      async () => {
        packaged += 1
        await Promise.resolve()
        return { status: 'succeeded' as const, artifact }
      }
    )

    const first = service.exportSavedScene(request)
    const second = service.exportSavedScene(request)
    readGate.resolve()
    const results = await Promise.all([first, second])
    expect(results).toEqual([
      { status: 'succeeded', artifact },
      { status: 'succeeded', artifact }
    ])
    expect(packaged).toBe(1)
  })

  it('同一版本导出到不同目的地分别打包，缓存不跨目的地复用', async () => {
    const packagedDestinations: SceneExportDestination[] = []
    const service = serviceWith(
      async () => saved,
      async (intent) =>
        intent?.kind === 'selected' ? selectedDestination : workspaceDestination,
      async (_input, destination) => {
        packagedDestinations.push(destination)
        return { status: 'succeeded' as const, artifact: artifactOf(destination) }
      }
    )

    const workspace = await service.exportSavedScene(request)
    const selected = await service.exportSavedScene({
      ...request,
      destination: { kind: 'selected', selectionId }
    })
    expect(packagedDestinations).toEqual([workspaceDestination, selectedDestination])
    expect(workspace).toMatchObject({ status: 'succeeded' })
    expect(selected).toMatchObject({ status: 'succeeded' })
    if (workspace.status !== 'succeeded' || selected.status !== 'succeeded') return
    expect(workspace.artifact.directoryPath).not.toBe(selected.artifact.directoryPath)
  })

  it('生成提交引用可以进入同一导出编排，并按引用身份去重', async () => {
    const generationRequest = {
      ...request,
      versionReference: {
        kind: 'generation-commit' as const,
        operationId: 'generation-operation-1',
        commitId: 'a'.repeat(40)
      }
    }
    const generationSaved: SavedSceneExportSource = {
      ...saved,
      versionReference: generationRequest.versionReference
    }
    let packaged = 0
    const artifact = {
      ...artifactOf(workspaceDestination),
      versionReference: generationRequest.versionReference
    }
    const service = serviceWith(
      async () => generationSaved,
      undefined,
      async () => {
        packaged += 1
        return { status: 'succeeded' as const, artifact }
      }
    )

    await expect(service.exportSavedScene(generationRequest)).resolves.toEqual({
      status: 'succeeded',
      artifact
    })
    await expect(service.exportSavedScene(generationRequest)).resolves.toEqual({
      status: 'succeeded',
      artifact
    })
    expect(packaged).toBe(1)
  })

  it('伪造或跨来源的版本引用在读取保存内容前拒绝', async () => {
    let reads = 0
    const service = serviceWith(async () => {
      reads += 1
      return saved
    })
    const invalid = [
      {
        kind: 'generation-commit',
        operationId: 'generation-operation-1',
        commitId: 'not-a-git-commit'
      },
      {
        kind: 'generation-commit',
        operationId: 'generation operation with spaces',
        commitId: 'a'.repeat(40)
      },
      {
        kind: 'generation-commit',
        operationId: 'generation-operation-1',
        commitId: 'a'.repeat(40),
        requestId: 'preview-request-1'
      },
      { kind: 'candidate-snapshot', snapshotId: 'candidate-1' }
    ]
    for (const versionReference of invalid) {
      await expect(
        service.exportSavedScene({ ...request, versionReference } as never)
      ).rejects.toMatchObject({ code: SceneExportErrorCodes.exportInputRejected })
    }
    expect(reads).toBe(0)
  })

  it('来源返回的版本引用与请求不一致时拒绝，不把另一种来源当成授权', async () => {
    const service = serviceWith(async () => saved)
    await expect(
      service.exportSavedScene({
        ...request,
        versionReference: {
          kind: 'generation-commit',
          operationId: 'generation-operation-1',
          commitId: 'a'.repeat(40)
        }
      })
    ).rejects.toMatchObject({ code: SceneExportErrorCodes.savedContentMismatch })
  })
})

function artifactOf(destination: SceneExportDestination): WindowsScenePackageVO {
  const directoryName = `scene-${'a'.repeat(16)}`
  return {
    executableName: 'WebGAL.exe',
    directoryName,
    directoryPath: `${destination.parentDirectory}/${directoryName}`,
    bytes: 12,
    containsFixedEngine: true,
    entryRelativePath: saved.entryRelativePath,
    contentBasis: basis,
    versionReference: saved.versionReference
  }
}

function serviceWith(
  readSavedScene: SceneExportSourceGateway['readSavedScene'],
  resolveDestination: (
    intent: SceneExportDestinationDTO | undefined
  ) => Promise<SceneExportDestination> = async () => workspaceDestination,
  packageWindowsScene: WindowsScenePackager['packageWindowsScene'] = async () =>
    unavailable(),
  verifyWindowsScene: WindowsScenePackager['verifyWindowsScene'] = async () => true
): ExportSavedScene {
  return new ExportSavedScene({
    sources: sources(readSavedScene),
    destinations: destinations(resolveDestination),
    packager: packager(packageWindowsScene, verifyWindowsScene)
  })
}

function sources(
  readSavedScene: SceneExportSourceGateway['readSavedScene']
): SceneExportSourceGateway {
  return { readSavedScene }
}

function destinations(
  resolveDestination: (
    intent: SceneExportDestinationDTO | undefined
  ) => Promise<SceneExportDestination>
): SceneExportDestinationGateway {
  return {
    chooseParentDirectory: vi.fn(async () => ({ status: 'canceled' as const })),
    resolveDestination: (_scene, intent) => resolveDestination(intent)
  }
}

function packager(
  packageWindowsScene: WindowsScenePackager['packageWindowsScene'],
  verifyWindowsScene: WindowsScenePackager['verifyWindowsScene'] = async () => true
): WindowsScenePackager {
  return { packageWindowsScene, verifyWindowsScene }
}

function unavailable(): WindowsScenePackageResult {
  return {
    status: 'unavailable',
    reason: 'windowsPackagerUnavailable',
    message: '当前没有可调用的 Windows 桌面打包入口'
  }
}
