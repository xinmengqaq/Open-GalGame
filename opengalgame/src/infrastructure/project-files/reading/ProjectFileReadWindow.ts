import { realpath } from 'node:fs/promises'
import { z } from 'zod'

import { AppException } from '@common/errors/AppException'
import { ProjectFileErrorCodes } from '@domain/project-files/errors/ProjectFileErrorCodes'
import {
  assertSameObservation,
  captureProjectDirectory,
  decodeStrictUtf8,
  digestProjectFile,
  observeProjectFile,
  readProjectFilePrefix,
  readStableProjectFile,
  sameFileStats,
  StableFileReadError,
  type DirectorySnapshot,
  type ObservedProjectFile
} from '@infrastructure/storage/StableProjectFileReader'
import { parseJsonDocumentContent } from '@infrastructure/storage/jsonDocument'
import { parseUnknownValue } from '@infrastructure/validation/parseUnknownValue'
import { digestBytes, MAX_JSON_BYTES, projectFileLocations as locations } from '../projectFilePaths'
import { projectFileReadException } from '../projectFileReadErrors'

const manifestIdentitySchema = z.object({ projectId: z.string().min(1) })

type TrackedFile = ObservedProjectFile & { digest: string }

type MissingPath = { relativePath: string }

/** 一次工程文件读取窗口。结束前核对身份文件、已读文件和目录成员。 */
export class ProjectFileReadWindow {
  private readonly files: TrackedFile[] = []
  private readonly directories: DirectorySnapshot[] = []
  private readonly missing: MissingPath[] = []

  private constructor(
    readonly root: string,
    readonly projectId: string
  ) {}

  /**
   * @throws {AppException} 工程根或身份文件无法使用。
   */
  static async open(directory: string, projectId: string): Promise<ProjectFileReadWindow> {
    let root: string
    try {
      root = await realpath(directory)
    } catch (error) {
      throw new AppException({
        code: ProjectFileErrorCodes.readFailed,
        msg: '工程文件无法读取',
        cause: error
      })
    }
    const window = new ProjectFileReadWindow(root, projectId)
    try {
      const manifest = await window.readBytes(locations.manifest)
      const value = parseJsonDocumentContent(decodeStrictUtf8(manifest.bytes), {
        code: ProjectFileErrorCodes.readFailed,
        msg: '工程文件无法读取'
      })
      const identity = parseUnknownValue(
        manifestIdentitySchema,
        value,
        ProjectFileErrorCodes.readFailed,
        '工程文件无法读取'
      )
      if (identity.projectId !== projectId) {
        throw new AppException({
          code: ProjectFileErrorCodes.ownershipMismatch,
          msg: '工程文件归属不匹配'
        })
      }
      return window
    } catch (error) {
      if (error instanceof StableFileReadError && error.kind === 'missing') {
        throw new AppException({
          code: ProjectFileErrorCodes.readFailed,
          msg: '工程文件无法读取',
          cause: error
        })
      }
      throw error
    }
  }

  async readBytes(
    relativePath: string,
    maxBytes?: number
  ): Promise<{ bytes: Buffer; digest: string }> {
    const { observation, bytes } = await readStableProjectFile(this.root, relativePath, maxBytes)
    const digest = digestBytes(bytes)
    this.files.push({ ...observation, digest })
    return { bytes, digest }
  }

  /**
   * 读取不超过 JSON 上限的严格 UTF-8 文本。
   * @throws {StableFileReadError} 编码非法或文件过大。
   */
  async readText(relativePath: string): Promise<{ text: string; digest: string }> {
    const { bytes, digest } = await this.readBytes(relativePath, MAX_JSON_BYTES)
    try {
      return { text: decodeStrictUtf8(bytes), digest }
    } catch (error) {
      throw new StableFileReadError('invalid-text', relativePath, '不是合法 UTF-8', error)
    }
  }

  /**
   * 读取可选 JSON 文本。缺失记入窗口；超过大小上限视为损坏。
   * @returns 文本和摘要；不存在时为 null。
   */
  async readOptionalText(relativePath: string): Promise<{ text: string; digest: string } | null> {
    try {
      return await this.readText(relativePath)
    } catch (error) {
      if (error instanceof StableFileReadError && error.kind === 'missing') {
        this.missing.push({ relativePath })
        return null
      }
      throw error
    }
  }

  /**
   * 读取可选文本，不套用来源 JSON 的固定容量上限。
   * @returns 文本和摘要；不存在时为 null。
   */
  async readOptionalUnboundedText(
    relativePath: string
  ): Promise<{ text: string; digest: string } | null> {
    try {
      const { bytes, digest } = await this.readBytes(relativePath)
      try {
        return { text: decodeStrictUtf8(bytes), digest }
      } catch (error) {
        throw new StableFileReadError('invalid-text', relativePath, '不是合法 UTF-8', error)
      }
    } catch (error) {
      if (error instanceof StableFileReadError && error.kind === 'missing') {
        this.missing.push({ relativePath })
        return null
      }
      throw error
    }
  }

  /**
   * 确认文件存在并只记录状态，不读取内容。
   * @returns 文件观察结果；不存在时为 null。
   */
  async observeExisting(relativePath: string): Promise<ObservedProjectFile | null> {
    try {
      const observation = await observeProjectFile(this.root, relativePath)
      this.files.push({ ...observation, digest: '' })
      return observation
    } catch (error) {
      if (error instanceof StableFileReadError && error.kind === 'missing') {
        this.missing.push({ relativePath })
        return null
      }
      throw error
    }
  }

  /**
   * 读取文件前缀，不计算整文件摘要。
   * @returns 前缀和大小；文件不存在时为 null。
   */
  async readPrefix(
    relativePath: string,
    length = 8192
  ): Promise<{ prefix: Buffer; size: number } | null> {
    const observation = await this.observeExisting(relativePath)
    if (!observation?.stats) return null
    const prefix = await readProjectFilePrefix(observation.absolutePath, length)
    await assertSameObservation(this.root, observation)
    return { prefix, size: Number(observation.stats.size) }
  }

  async readMedia(relativePath: string): Promise<{ prefix: Buffer; digest: string; size: number }> {
    const observation = await observeProjectFile(this.root, relativePath)
    if (!observation.stats) throw new StableFileReadError('missing', relativePath, '文件不存在')
    const prefix = await readProjectFilePrefix(observation.absolutePath, 8192)
    const digest = await digestProjectFile(observation.absolutePath)
    await assertSameObservation(this.root, observation)
    this.files.push({ ...observation, digest })
    return { prefix, digest, size: Number(observation.stats.size) }
  }

  /**
   * 读取可选文件。缺失记入窗口，不立刻失败。
   * @returns 字节；不存在时为 null。
   * @throws {StableFileReadError} 超过大小上限、不是文件或无法读取。
   */
  async readOptionalBytes(
    relativePath: string,
    maxBytes?: number
  ): Promise<{ bytes: Buffer; digest: string } | null> {
    try {
      return await this.readBytes(relativePath, maxBytes)
    } catch (error) {
      if (error instanceof StableFileReadError && error.kind === 'missing') {
        this.missing.push({ relativePath })
        return null
      }
      throw error
    }
  }

  /**
   * 拍摄目录成员快照。目录不存在时为空快照并记录缺失。
   * @returns 成员快照；目录不存在时为 null。
   */
  async captureDirectory(relativePath: string): Promise<DirectorySnapshot | null> {
    const snapshot = await captureProjectDirectory(this.root, relativePath)
    if (snapshot === null) {
      this.missing.push({ relativePath })
      return null
    }
    this.directories.push(snapshot)
    return snapshot
  }

  /**
   * 重新核对已观察文件、缺失项、目录成员和身份清单。
   * @throws {StableFileReadError} 读取期间发生变化。
   */
  async finish(): Promise<void> {
    for (const file of this.files) {
      await assertSameObservation(this.root, file)
      if (file.digest === '') continue
      const current = await digestProjectFile(file.absolutePath)
      if (current !== file.digest) {
        throw new StableFileReadError('changed', file.relativePath, '文件在读取期间变化')
      }
    }
    for (const path of this.missing) {
      try {
        await observeProjectFile(this.root, path.relativePath)
        throw new StableFileReadError('changed', path.relativePath, '文件在读取期间变化')
      } catch (error) {
        if (error instanceof StableFileReadError && error.kind === 'missing') continue
        if (error instanceof StableFileReadError && error.kind === 'changed') throw error
        const snapshot = await captureProjectDirectory(this.root, path.relativePath)
        if (snapshot !== null) {
          throw new StableFileReadError('changed', path.relativePath, '文件在读取期间变化')
        }
      }
    }
    for (const directory of this.directories) {
      const current = await captureProjectDirectory(this.root, directory.relativePath)
      if (
        current === null ||
        current.members.length !== directory.members.length ||
        current.members.some(
          (member, index) =>
            member.name !== directory.members[index]?.name ||
            !sameFileStats(member.stats, directory.members[index]?.stats)
        )
      ) {
        throw new StableFileReadError('changed', directory.relativePath, '目录在读取期间变化')
      }
    }
  }
}

/**
 * @throws {AppException} 路径、格式或读取变化失败。
 */
export async function withProjectFileRead<T>(
  directory: string,
  projectId: string,
  read: (window: ProjectFileReadWindow) => Promise<T>
): Promise<T> {
  try {
    const window = await ProjectFileReadWindow.open(directory, projectId)
    const result = await read(window)
    await window.finish()
    return result
  } catch (error) {
    throw projectFileReadException(error)
  }
}
