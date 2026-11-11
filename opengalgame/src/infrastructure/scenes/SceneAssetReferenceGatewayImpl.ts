import * as fs from 'node:fs/promises'

import type { ParsedScene, ParsedSceneAssetReference } from '@application/scenes/models/ParsedScene'
import type { SceneReferenceFact } from '@application/scenes/models/SceneReferenceFact'
import type { SceneSourceSnapshot } from '@application/scenes/models/SceneSourceSnapshot'
import type { SceneAssetReferenceGateway } from '@application/scenes/ports/SceneAssetReferenceGateway'
import { AppException } from '@common/errors/AppException'
import { ErrorCodes } from '@common/errors/ErrorCodes'
import { assertRelativePath, resolveContained } from '@infrastructure/git/containedPath'
import {
  projectAssetRelativePaths,
  WEBGAL_ASSET_DIRECTORIES
} from '@infrastructure/webgal/assetPath'
import { WebgalInfrastructureError } from '@infrastructure/webgal/WebgalInfrastructureError'
import { sceneReadException } from './sceneReadErrors'

/** 只检查该场景实际引用的资源可达性。 */
export class SceneAssetReferenceGatewayImpl implements SceneAssetReferenceGateway {
  /**
   * @returns 每个引用的可达性或缺失、外部、非法、清除状态。
   * @throws {AppException} 内容依据不一致或素材查询故障。
   */
  async checkSceneAssetReferences(
    snapshot: SceneSourceSnapshot,
    scene: ParsedScene
  ): Promise<readonly SceneReferenceFact[]> {
    try {
      if (
        scene.contentDigest !== snapshot.digest ||
        !snapshot.files.some(
          (file) =>
            file.relativePath === scene.sourceFile.relativePath &&
            file.digest === scene.sourceFile.digest
        )
      ) {
        throw new WebgalInfrastructureError(
          'inconsistent-read',
          '解析结果与源快照不一致，请重新读取'
        )
      }
      const facts: SceneReferenceFact[] = []
      for (const reference of scene.assets)
        facts.push(await checkReference(snapshot.projectRoot, reference))
      return facts
    } catch (error) {
      if (error instanceof WebgalInfrastructureError) throw sceneReadException(error)
      throw sceneReadException(
        new WebgalInfrastructureError('read-failed', '无法查询场景素材引用', undefined, {
          cause: error
        })
      )
    }
  }
}

/**
 * 逐个按共用优先级查找普通文件，拒绝任何路径和链接逃逸。
 * @throws {WebgalInfrastructureError} 文件查询故障。
 */
async function checkReference(
  root: string,
  reference: ParsedSceneAssetReference
): Promise<SceneReferenceFact> {
  const fact = {
    rawReference: reference.rawReference,
    runtimeReference: reference.runtimeReference,
    kind: reference.kind,
    sourceLine: reference.line
  }
  if (reference.isCleared) return { ...fact, status: 'cleared' }
  if (/^https?:\/\//iu.test(reference.runtimeReference)) return { ...fact, status: 'external' }
  try {
    if (!(WEBGAL_ASSET_DIRECTORIES as readonly string[]).includes(reference.kind)) {
      return { ...fact, status: 'invalid-path' }
    }
    assertRelativePath(reference.rawReference.replaceAll('\\', '/').replace(/^\.\//u, ''))
    for (const relativePath of projectAssetRelativePaths(reference.kind, reference.rawReference)) {
      const path = await resolveContained(root, relativePath)
      try {
        const stats = await fs.stat(path)
        if (stats.isFile()) return { ...fact, status: 'present', relativePath }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    }
    return { ...fact, status: 'missing' }
  } catch (error) {
    if (
      error instanceof AppException &&
      error.code === ErrorCodes.forbidden &&
      error.cause === undefined
    ) {
      return { ...fact, status: 'invalid-path' }
    }
    throw new WebgalInfrastructureError(
      'read-failed',
      '无法查询场景素材引用',
      reference.rawReference,
      { cause: error }
    )
  }
}
