import { createHash } from 'node:crypto'
import * as fs from 'node:fs/promises'
import type { BigIntStats } from 'node:fs'
import { isAbsolute } from 'node:path'

import type {
  ReadSceneSourceRequest,
  SceneFileKind,
  SceneSourceFile,
  SceneSourceSnapshot
} from '@application/scenes/models/SceneSourceSnapshot'
import type { SceneSourceReaderGateway } from '@application/scenes/ports/SceneSourceReaderGateway'
import { AppException } from '@common/errors/AppException'
import {
  decodeStrictUtf8,
  observeProjectFile,
  sameFileStats,
  StableFileReadError
} from '@infrastructure/storage/StableProjectFileReader'
import { WEBGAL_COMPATIBILITY_PROFILE } from '@infrastructure/webgal/compatibility/WebgalCompatibilityProfile'
import { WebgalInfrastructureError } from '@infrastructure/webgal/WebgalInfrastructureError'
import { sceneReadException } from './sceneReadErrors'

type SourceObservation = {
  readonly relativePath: string
  readonly kind: SceneFileKind
  readonly path: string
  readonly stats?: BigIntStats
}

export class SceneSourceReaderGatewayImpl implements SceneSourceReaderGateway {
  async readSceneSource(request: ReadSceneSourceRequest): Promise<SceneSourceSnapshot> {
    try {
      if (!isAbsolute(request.projectRoot)) {
        throw new WebgalInfrastructureError('invalid-path', '工程根必须为绝对路径')
      }
      const projectRoot = await fs.realpath(request.projectRoot)
      const entryPath = request.entryFile ?? WEBGAL_COMPATIBILITY_PROFILE.entryScript
      const kinds = new Map<string, SceneFileKind>([[entryPath, 'entry']])
      for (const path of request.sceneFiles ?? []) {
        if (!kinds.has(path)) kinds.set(path, 'scene')
      }
      for (const path of request.metadataFiles ?? ['.opengalgame/scene-locks.json']) {
        if (kinds.has(path)) {
          throw new WebgalInfrastructureError('invalid-path', '脚本与元信息文件路径不能重叠', path)
        }
        kinds.set(path, 'metadata')
      }
      const observations: SourceObservation[] = []
      for (const [relativePath, kind] of kinds) {
        observations.push(await observeSource(projectRoot, relativePath, kind))
      }
      const files: SceneSourceFile[] = []
      for (const observation of observations) {
        if (!observation.stats) continue
        const bytes = await readObservedSource(projectRoot, observation)
        files.push({
          relativePath: observation.relativePath,
          kind: observation.kind,
          bytes: new Uint8Array(bytes),
          text: decodeSource(bytes, observation.relativePath),
          size: bytes.byteLength,
          modifiedAtMs: Number(observation.stats.mtimeNs) / 1_000_000,
          digest: createHash('sha256').update(bytes).digest('hex')
        })
      }
      for (const file of files) {
        const observation = observations.find((item) => item.relativePath === file.relativePath)!
        const bytes = await readObservedSource(projectRoot, observation)
        if (!Buffer.from(file.bytes).equals(bytes)) throw inconsistent(file.relativePath)
      }
      for (const observation of observations) await verifyObservation(projectRoot, observation)
      const missingMetadataFiles = observations
        .filter((item) => !item.stats)
        .map((item) => item.relativePath)
      const digest = createHash('sha256')
      for (const observation of [...observations].sort((a, b) =>
        a.relativePath.localeCompare(b.relativePath)
      )) {
        const file = files.find((item) => item.relativePath === observation.relativePath)
        digest.update(
          JSON.stringify([observation.relativePath, observation.kind, file?.digest ?? null])
        )
        digest.update('\n')
      }
      return {
        projectRoot,
        entryFile: files[0]!,
        files,
        missingMetadataFiles,
        digest: digest.digest('hex')
      }
    } catch (error) {
      if (error instanceof AppException || error instanceof WebgalInfrastructureError) {
        throw sceneReadException(error)
      }
      throw sceneReadException(
        new WebgalInfrastructureError('read-failed', '无法读取场景源文件', undefined, {
          cause: error
        })
      )
    }
  }
}

async function observeSource(
  root: string,
  relativePath: string,
  kind: SceneFileKind
): Promise<SourceObservation> {
  try {
    const observed = await observeProjectFile(root, relativePath)
    return { relativePath, kind, path: observed.absolutePath, stats: observed.stats }
  } catch (error) {
    if (error instanceof StableFileReadError && error.kind === 'missing') {
      if (kind === 'metadata') {
        return { relativePath, kind, path: error.absolutePath ?? relativePath }
      }
      throw new WebgalInfrastructureError(
        kind === 'entry' ? 'missing-entry' : 'missing-file',
        '场景源文件不存在',
        relativePath,
        { cause: error.cause }
      )
    }
    if (error instanceof StableFileReadError && error.kind === 'not-file') {
      throw new WebgalInfrastructureError('read-failed', '场景源路径不是普通文件', relativePath)
    }
    if (error instanceof StableFileReadError && error.cause !== undefined) throw error.cause
    throw error
  }
}

async function verifyObservation(root: string, observation: SourceObservation): Promise<void> {
  try {
    const current = await observeSource(root, observation.relativePath, observation.kind)
    if (current.path !== observation.path || !sameFileStats(current.stats, observation.stats)) {
      throw inconsistent(observation.relativePath)
    }
  } catch (error) {
    if (error instanceof WebgalInfrastructureError && error.kind === 'inconsistent-read')
      throw error
    const cause = error instanceof AppException ? error.cause : error
    const code = (cause as NodeJS.ErrnoException | undefined)?.code
    if (
      error instanceof WebgalInfrastructureError ||
      code === 'ENOENT' ||
      code === 'ENOTDIR' ||
      (error instanceof AppException && error.cause === undefined)
    ) {
      throw inconsistent(observation.relativePath, error)
    }
    throw new WebgalInfrastructureError(
      'read-failed',
      '无法核对场景源文件状态',
      observation.relativePath,
      { cause: error }
    )
  }
}

async function readObservedSource(root: string, observation: SourceObservation): Promise<Buffer> {
  await verifyObservation(root, observation)
  let bytes: Buffer
  try {
    bytes = await fs.readFile(observation.path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      throw inconsistent(observation.relativePath, error)
    throw new WebgalInfrastructureError(
      'read-failed',
      '无法读取场景源文件',
      observation.relativePath,
      { cause: error }
    )
  }
  await verifyObservation(root, observation)
  return bytes
}

function decodeSource(bytes: Uint8Array, path: string): string {
  try {
    return decodeStrictUtf8(bytes)
  } catch (error) {
    throw new WebgalInfrastructureError(
      'invalid-encoding',
      '场景源文件不是合法的 UTF-8 文本',
      path,
      { cause: error }
    )
  }
}

function inconsistent(path: string, cause?: unknown): WebgalInfrastructureError {
  return new WebgalInfrastructureError(
    'inconsistent-read',
    '场景内容在读取过程中变化，请重新读取',
    path,
    { cause }
  )
}
