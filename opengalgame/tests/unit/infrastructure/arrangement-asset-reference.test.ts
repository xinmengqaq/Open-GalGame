import { describe, expect, it } from 'vitest'

import type { SceneGenerationExecution } from '@application/scene-generation/models/SceneGenerationExecution'
import { SceneGenerationContextAssemblerImpl } from '@infrastructure/scene-generation/agents/context/SceneGenerationContextAssemblerImpl'
import { encodeStorageKey } from '@infrastructure/project-files/projectFilePaths'
import {
  neutralSceneAssetReference,
  projectAssetRelativePaths,
  projectPathsForGameRequest,
  resolveSceneAssetReference
} from '@infrastructure/webgal/assetPath'

const sourceId = 'b98970a8-2b4c-4285-b3f8-04a377d5c27c'

describe('编排登记路径', () => {
  const storageKey = encodeStorageKey(sourceId)
  const registeredPath = `assets/${storageKey}/dansei_16_a.png`
  const commandReference = `${storageKey}/dansei_16_a.png`

  it('命令引用保留来源存储键，种类目录下的旧路径仍去掉目录', () => {
    expect(neutralSceneAssetReference(registeredPath)).toBe(commandReference)
    expect(neutralSceneAssetReference('assets/background/station.svg')).toBe('station.svg')
    expect(neutralSceneAssetReference('game/figure/student/happy.png')).toBe('student/happy.png')
    expect(neutralSceneAssetReference('dansei_16_a.png')).toBe('dansei_16_a.png')
    expect(() => neutralSceneAssetReference('game/scene/start.txt')).toThrow('素材用途无法解析')
  })

  it('查找认到来源存储键下的文件，整段 assets 原文和纯文件名不加这条', () => {
    expect(projectAssetRelativePaths('background', commandReference)).toEqual([
      `game/background/${commandReference}`,
      `assets/background/${commandReference}`,
      registeredPath
    ])
    expect(projectPathsForGameRequest(`background/${commandReference}`)).toEqual([
      `game/background/${commandReference}`,
      `assets/background/${commandReference}`,
      registeredPath
    ])
    expect(projectAssetRelativePaths('background', registeredPath)).not.toContain(registeredPath)
    expect(projectAssetRelativePaths('background', 'station.svg')).toEqual([
      'game/background/station.svg',
      'assets/background/station.svg'
    ])
  })

  it('同一 resolver 给出命令引用、源路径和规范路径，用途不明时失败', () => {
    expect(
      resolveSceneAssetReference({
        sourcePath: registeredPath,
        runtimeDirectory: 'figure'
      })
    ).toEqual({
      commandReference,
      sourcePath: registeredPath,
      canonicalPath: `game/figure/${commandReference}`
    })
    expect(
      resolveSceneAssetReference({
        sourcePath: 'game/background/room.webp',
        runtimeDirectory: 'background'
      })
    ).toEqual({
      commandReference: 'room.webp',
      sourcePath: 'game/background/room.webp',
      canonicalPath: 'game/background/room.webp'
    })
    expect(() =>
      resolveSceneAssetReference({
        sourcePath: registeredPath,
        runtimeDirectory: 'unknown'
      })
    ).toThrow('素材用途无法解析')
    expect(projectAssetRelativePaths('figure', commandReference)[0]).toBe(
      `game/figure/${commandReference}`
    )
    expect(projectAssetRelativePaths('figure', commandReference)).toContain(registeredPath)
  })

  it('导出命令引用无法落到规范路径时明确失败，不生成缺资源结果', () => {
    expect(() =>
      resolveSceneAssetReference({
        sourcePath: 'assets/untyped/hero.png',
        runtimeDirectory: 'figure'
      })
    ).toThrow('素材用途无法解析')
    expect(
      resolveSceneAssetReference({
        sourcePath: 'game/figure/hero.png',
        runtimeDirectory: 'figure'
      }).canonicalPath
    ).toBe('game/figure/hero.png')
  })

  it('交给模型的绑定使用编排登记路径算出的命令引用', () => {
    const assembled = JSON.parse(
      new SceneGenerationContextAssemblerImpl().assemble({
        mode: 'generate',
        execution: {
          projectId: 'project',
          sceneId: 'scene',
          source: { sceneDirectory: 'game/scene', entryFile: 'start.txt' },
          inputSnapshot: {
            assets: [
              {
                assetId: 'card-1',
                sourceId,
                name: '悠',
                relativePath: registeredPath,
                category: 'image',
                description: '张口',
                usage: { targetIds: [] }
              }
            ]
          },
          candidateSnapshotId: 'revision',
          budget: {},
          replies: []
        } as SceneGenerationExecution
      })
    ) as {
      assetBindings: {
        category: string
        commandReference: string
        relativePath: string
      }[]
    }

    expect(assembled.assetBindings[0]).toMatchObject({
      relativePath: registeredPath,
      commandReference,
      category: 'image'
    })
    expect(assembled.assetBindings[0]).not.toHaveProperty('purpose')
    expect(assembled.assetBindings[0]).not.toHaveProperty('defaultRuntimeDirectory')
    expect(assembled.assetBindings[0]).not.toHaveProperty('role')
  })

  it('音频类别只作命令族提示，说明和稳定引用不随类别改写', () => {
    const audioSourceId = '1f0a1b2c-3d4e-4f50-8a6b-7c8d9e0f1a2b'
    const audioKey = encodeStorageKey(audioSourceId)
    const audioPath = `assets/${audioKey}/duck.ogg`
    const assembled = JSON.parse(
      new SceneGenerationContextAssemblerImpl().assemble({
        mode: 'generate',
        execution: {
          projectId: 'project',
          sceneId: 'scene',
          source: { sceneDirectory: 'game/scene', entryFile: 'start.txt' },
          inputSnapshot: {
            assets: [
              {
                assetId: 'card-audio',
                sourceId: audioSourceId,
                name: '环境音',
                relativePath: audioPath,
                category: 'audio',
                description: '下压音效',
                usage: { targetIds: [] }
              }
            ]
          },
          candidateSnapshotId: 'revision',
          budget: {},
          replies: []
        } as SceneGenerationExecution
      })
    ) as {
      assetBindings: {
        category: string
        description: string
        relativePath: string
        commandReference: string
      }[]
    }

    expect(assembled.assetBindings[0]).toMatchObject({
      category: 'audio',
      description: '下压音效',
      relativePath: audioPath,
      commandReference: `${audioKey}/duck.ogg`
    })
    expect(assembled.assetBindings[0]).not.toHaveProperty('defaultRuntimeDirectory')
    expect(assembled.assetBindings[0]).not.toHaveProperty('runtimeDirectory')
  })
})
