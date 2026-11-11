import * as fs from 'node:fs'
import * as git from 'isomorphic-git'
import type { CommitObject } from 'isomorphic-git'

import { bytesEqual } from './objects/gitContent'
import { unavailable } from './gitErrors'
import {
  operationRef,
  writeOperationRecord,
  type OperationRecord
} from './transaction/OperationRecord'
import { AppException } from '@common/errors/AppException'
import { ErrorCodes } from '@common/errors/ErrorCodes'

export interface GitEffects {
  /**
   * @throws {AppException} 写入或核对失败。
   */
  writeBytes(absolutePath: string, bytes: Uint8Array): Promise<void>

  /**
   * 删除工作区文件，文件不存在时不做事。
   * @throws {AppException} 删除失败。
   */
  removeFile(absolutePath: string): Promise<void>

  /**
   * 只更新一条索引记录，不改写其他路径。
   * @param oid - 要登记的 blob；删除索引项时不传。
   * @throws {AppException} 索引更新失败。
   */
  stageBlob(projectRoot: string, relativePath: string, oid: string | null): Promise<void>

  /**
   * 写入提交对象，不移动分支或操作引用。
   * @throws {AppException} 对象写入失败。
   */
  writeCommit(projectRoot: string, commit: CommitObject): Promise<string>

  /**
   * 仅当分支仍指向预期提交时推进它。
   * @param branchRef - 已固定的分支全名。
   * @param expectedOid - 发布前分支必须仍指向的提交。
   * @throws {AppException} 分支已变化或无法更新。
   */
  updateBranch(
    projectRoot: string,
    branchRef: string,
    oid: string,
    expectedOid: string
  ): Promise<void>

  /**
   * @throws {AppException} 引用无法发布。
   */
  writeOperationRef(projectRoot: string, operationId: string, oid: string): Promise<void>

  /**
   * @throws {AppException} 记录写入失败。
   */
  writeRecord(projectRoot: string, record: OperationRecord): Promise<void>
}

/**
 * @throws {AppException} 写入或核对失败。
 */
export async function writeVerifiedBytes(absolutePath: string, bytes: Uint8Array): Promise<void> {
  const { mkdir, readFile, rename, rm, writeFile } = await import('node:fs/promises')
  const { dirname, join } = await import('node:path')
  const { randomUUID } = await import('node:crypto')
  const temporary = join(dirname(absolutePath), `.opengalgame-tmp-${randomUUID()}`)
  try {
    await mkdir(dirname(absolutePath), { recursive: true })
    await writeFile(temporary, bytes, { flag: 'wx', flush: true })
    const written = new Uint8Array(await readFile(temporary))
    if (!bytesEqual(written, bytes)) {
      throw unavailable(new Error('temporary mismatch'), '文件写入后与内容不一致')
    }
    await rename(temporary, absolutePath)
    const stored = new Uint8Array(await readFile(absolutePath))
    if (!bytesEqual(stored, bytes)) {
      throw unavailable(new Error('final mismatch'), '文件写入后与内容不一致')
    }
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined)
    if (error instanceof AppException) throw error
    throw unavailable(error, '作品文件写入失败')
  }
}

/** 使用 Node 文件能力和 isomorphic-git 的默认技术边界。 */
export const realGitEffects: GitEffects = {
  writeBytes: writeVerifiedBytes,

  async removeFile(absolutePath) {
    const { rm } = await import('node:fs/promises')
    try {
      await rm(absolutePath, { force: true })
    } catch (error) {
      throw unavailable(error, '作品文件无法删除')
    }
  },

  async stageBlob(projectRoot, relativePath, oid) {
    try {
      if (oid === null) {
        await git.updateIndex({
          fs,
          dir: projectRoot,
          filepath: relativePath,
          remove: true,
          force: true
        })
        return
      }
      await git.updateIndex({
        fs,
        dir: projectRoot,
        filepath: relativePath,
        oid,
        mode: 0o100644,
        add: true
      })
    } catch (error) {
      throw unavailable(error, '作品索引更新失败')
    }
  },

  async writeCommit(projectRoot, commit) {
    try {
      return await git.writeCommit({ fs, dir: projectRoot, commit })
    } catch (error) {
      throw unavailable(error, '作品提交对象写入失败')
    }
  },

  async updateBranch(projectRoot, branchRef, oid, expectedOid) {
    try {
      const current = await git.resolveRef({ fs, dir: projectRoot, ref: branchRef })
      if (current !== expectedOid) {
        throw new AppException({
          code: ErrorCodes.operationConflict,
          msg: '作品基线或目标文件已变化，已拒绝写入'
        })
      }
      await git.writeRef({ fs, dir: projectRoot, ref: branchRef, value: oid, force: true })
    } catch (error) {
      if (error instanceof AppException) throw error
      throw unavailable(error, '作品分支无法更新')
    }
  },

  async writeOperationRef(projectRoot, operationId, oid) {
    try {
      await git.writeRef({
        fs,
        dir: projectRoot,
        ref: operationRef(operationId),
        value: oid,
        force: true
      })
    } catch (error) {
      throw unavailable(error, '作品操作引用无法发布')
    }
  },

  async writeRecord(projectRoot, record) {
    await writeOperationRecord(projectRoot, record)
  }
}
