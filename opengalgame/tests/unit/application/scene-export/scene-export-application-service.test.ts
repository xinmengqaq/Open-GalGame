import { describe, expect, it } from 'vitest'

import type { SceneContentBasisVO } from '@application/scene-preview/vo/ScenePreviewSessionVO'
import type {
  SavedSceneExportSource,
  SceneExportSourceGateway
} from '@application/scene-export/ports/SceneExportSourceGateway'
import type {
  WindowsScenePackageResult,
  WindowsScenePackager
} from '@application/scene-export/ports/WindowsScenePackager'
import { SceneExportApplicationServiceImpl } from '@application/scene-export/services/impl/SceneExportApplicationServiceImpl'
import { AppException } from '@common/errors/AppException'
import { SceneExportErrorCodes } from '@domain/scene-export/errors/SceneExportErrorCodes'

const basis: SceneContentBasisVO = {
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
  sceneText: '小明:已保存的一句;',
  referencedAssets: [{ sourcePath: 'game/figure/hero.png', packagePath: 'game/figure/hero.png' }]
}

describe('单场景 Windows 导出编排', () => {
  it('保存未成功时不调用打包', async () => {
    let packaged = 0
    const service = new SceneExportApplicationServiceImpl({
      sources: sources(async () => {
        throw new AppException({
          code: SceneExportErrorCodes.saveNotCommitted,
          msg: '当前场景还没有保存成功，不能导出'
        })
      }),
      packager: {
        async packageWindowsScene() {
          packaged += 1
          return unavailable()
        }
      }
    })

    await expect(service.exportSavedScene(request)).rejects.toMatchObject({
      code: SceneExportErrorCodes.saveNotCommitted
    })
    expect(packaged).toBe(0)
  })

  it('草稿、候选和越界输入在读取已保存内容前拒绝', async () => {
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
    expect(reads).toBe(0)
  })

  it('没有可运行 Windows 产物时返回能力不可用，不返回成功', async () => {
    const service = serviceWith(
      async () => saved,
      async () => unavailable()
    )
    await expect(service.exportSavedScene(request)).resolves.toEqual({
      status: 'unavailable',
      reason: 'windowsPackagerUnavailable',
      message: '当前没有可调用的 Windows 桌面打包入口'
    })
  })

  it('同一已保存依据重复导出复用原结果，不再次打包', async () => {
    let packaged = 0
    const artifact = {
      executableName: 'WebGAL.exe' as const,
      directoryName: 'saved-scene',
      directoryPath: 'D:/user/.opengalgame/exports/saved-scene',
      bytes: 12,
      containsFixedEngine: true as const,
      entryRelativePath: saved.entryRelativePath,
      contentBasis: basis,
      versionReference: saved.versionReference
    }
    const service = serviceWith(
      async () => saved,
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
    if (first.status !== 'succeeded') return
    expect(first.artifact.directoryPath).toMatch(/^(?:[A-Za-z]:[\\/]|\/)/u)
    expect(first.artifact.directoryPath).toMatch(/exports[\\/]saved-scene$/u)
  })
})

function serviceWith(
  readSavedScene: SceneExportSourceGateway['readSavedScene'],
  packageWindowsScene: WindowsScenePackager['packageWindowsScene'] = async () => unavailable()
): SceneExportApplicationServiceImpl {
  return new SceneExportApplicationServiceImpl({
    sources: sources(readSavedScene),
    packager: { packageWindowsScene }
  })
}

function sources(
  readSavedScene: SceneExportSourceGateway['readSavedScene']
): SceneExportSourceGateway {
  return { readSavedScene }
}

function unavailable(): WindowsScenePackageResult {
  return {
    status: 'unavailable',
    reason: 'windowsPackagerUnavailable',
    message: '当前没有可调用的 Windows 桌面打包入口'
  }
}
