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

export class ProjectFileReadWindow {
  private readonly files: TrackedFile[] = []
  private readonly directories: DirectorySnapshot[] = []
  private readonly missing: MissingPath[] = []

  private constructor(
    readonly root: string,
    readonly projectId: string
  ) {}

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

  async readText(relativePath: string): Promise<{ text: string; digest: string }> {
    const { bytes, digest } = await this.readBytes(relativePath, MAX_JSON_BYTES)
    try {
      return { text: decodeStrictUtf8(bytes), digest }
    } catch (error) {
      throw new StableFileReadError('invalid-text', relativePath, '不是合法 UTF-8', error)
    }
  }

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

  async captureDirectory(relativePath: string): Promise<DirectorySnapshot | null> {
    const snapshot = await captureProjectDirectory(this.root, relativePath)
    if (snapshot === null) {
      this.missing.push({ relativePath })
      return null
    }
    this.directories.push(snapshot)
    return snapshot
  }

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
