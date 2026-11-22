import * as fs from 'node:fs'
import * as git from 'isomorphic-git'

import type { SceneGenerationCheckpoint } from '@application/scene-generation/models/SceneGenerationExecution'
import { digestBytes } from '@infrastructure/git/objects/gitContent'
import {
  readCommitFiles,
  resolveRefIfExists,
  type GitLocation
} from '@infrastructure/git/objects/gitTree'

/**
 * 候选修订是否已发布到本线程的修订库；只有不可变引用才能作为历史依据。
 * @throws {AppException} 引用无法读取。
 */
export async function isPublishedRevision(
  location: GitLocation,
  revisionId: string
): Promise<boolean> {
  return (
    (await resolveRefIfExists(location, `refs/opengalgame/revisions/${revisionId}`)) === revisionId
  )
}

/**
 * 修订是否由指定操作保存。提交说明里的 Operation-Id 行是候选修订的唯一归属事实。
 * @throws {AppException} 提交无法读取。
 */
export async function revisionBelongsToOperation(
  location: GitLocation,
  revisionId: string,
  operationId: string
): Promise<boolean> {
  const commit = await git.readCommit({ fs, ...location, oid: revisionId })
  return commit.commit.message.split(/\r?\n/u).includes(`Operation-Id: ${operationId}`)
}

/**
 * 比较相邻不可变候选修订的真实字节，只给相对路径和前后摘要。
 * @param beforeRevisionId - 上一修订；没有上一修订时只给之后摘要。
 * @param afterRevisionId - 当前修订。
 * @returns 有变化的相对路径及前后摘要。
 * @throws {AppException} 修订或对象无法读取。
 */
export async function revisionFileDifferences(
  location: GitLocation,
  beforeRevisionId: string | undefined,
  afterRevisionId: string
): Promise<SceneGenerationCheckpoint['view']['differences']> {
  const current = await readCommitFiles(location, afterRevisionId)
  const previous = beforeRevisionId ? await readCommitFiles(location, beforeRevisionId) : []
  const before = new Map(previous.map((file) => [file.relativePath, digestBytes(file.bytes)]))
  const after = new Map(current.map((file) => [file.relativePath, digestBytes(file.bytes)]))
  return [...new Set([...before.keys(), ...after.keys()])].sort().flatMap((filePath) => {
    const beforeDigest = before.get(filePath)
    const afterDigest = after.get(filePath)
    if (beforeDigest === afterDigest) return []
    return [
      {
        filePath,
        ...(beforeDigest ? { beforeDigest } : {}),
        ...(afterDigest ? { afterDigest } : {})
      }
    ]
  })
}
