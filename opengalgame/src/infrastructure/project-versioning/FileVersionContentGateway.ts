import { readFile, rm } from 'node:fs/promises'
import { z } from 'zod'

import type { ImmutableCandidateInputDTO } from '@application/project-versioning/dto/ProjectVersioningDTO'
import type {
  VersionBoundRetention,
  VersionContentGateway,
  VersionReleaseRequest,
  VersionRetainRequest
} from '@application/project-versioning/ports/VersionContentGateway'
import { OPERATION_ID_PATTERN } from '@common/contracts/OperationId'
import { AppException } from '@common/errors/AppException'
import { ErrorCodes } from '@common/errors/ErrorCodes'
import { AiProjectFileSystemImpl } from '@infrastructure/ai/filesystem/AiProjectFileSystemImpl'
import { ProjectVersioningErrorCodes } from '@domain/project-versioning/errors/ProjectVersioningErrorCodes'
import {
  requireContentFingerprint,
  requireOperationId
} from '@domain/project-versioning/services/versionProtocolGuards'
import { assertRelativePath } from '@infrastructure/git/containedPath'
import { writeVerifiedBytes } from '@infrastructure/git/gitEffects'
import { bytesEqual, digestBytes } from '@infrastructure/git/objects/gitContent'
import { asGitException } from '@infrastructure/git/gitErrors'
import { enqueueWorkWrite } from '@infrastructure/git/transaction/workWriteBoundary'

import { resolveProjectWorkRoot } from './projectWorkRoot'
import {
  listVersionDocuments,
  parseVersionValue,
  readVersionValue,
  versionDocumentPath,
  writeVersionValue
} from './versionStore'

const manifestSchema = z.strictObject({
  formatVersion: z.literal(1),
  operationId: z.string().regex(OPERATION_ID_PATTERN),
  fingerprint: z.string().regex(/^[^\s]{1,256}$/u),
  entries: z.array(
    z.strictObject({
      relativePath: z.string().min(1),
      action: z.enum(['add', 'modify', 'delete']),
      retentionRef: z.union([z.string().regex(/^[0-9a-f]{64}$/u), z.null()])
    })
  )
})

type ContentManifest = z.infer<typeof manifestSchema>

const MANIFEST_DIRECTORY = ['opengalgame', 'version-content', 'manifests']
const OBJECT_DIRECTORY = ['opengalgame', 'version-content', 'objects']

/**
 * 为内联字节和已证明的场景候选形成可重启核对的内容身份。
 * 不能证明的候选、已准备引用、工作区路径和快照标识不能伪装成已保留。
 */
export class FileVersionContentGateway implements VersionContentGateway {
  private readonly revisions: AiProjectFileSystemImpl

  constructor(private readonly userDirectory: string) {
    this.revisions = new AiProjectFileSystemImpl(userDirectory)
  }

  async retain(input: VersionRetainRequest): Promise<readonly VersionBoundRetention[]> {
    requireOperationId(input.operationId)
    requireContentFingerprint(input.fingerprint)
    const root = await resolveProjectWorkRoot(this.userDirectory, input.projectId)
    const requested = await requestedRetentions(this.revisions, input.projectId, input)
    return enqueueWorkWrite(root, async () => {
      const existing = await readManifest(root, input.operationId)
      if (existing) {
        if (
          existing.fingerprint !== input.fingerprint ||
          !sameEntries(existing.entries, requested)
        ) {
          throw new AppException({
            code: ProjectVersioningErrorCodes.contentFingerprintConflict,
            msg: '同一操作不能更换内容'
          })
        }
        for (const entry of existing.entries) {
          if (entry.retentionRef) await readRetainedBlob(root, entry.retentionRef)
        }
        return existing.entries
      }
      const entries: VersionBoundRetention[] = []
      for (const entry of requested) {
        if (!entry.bytes) {
          entries.push({
            relativePath: entry.relativePath,
            action: entry.action,
            retentionRef: null
          })
          continue
        }
        entries.push({
          relativePath: entry.relativePath,
          action: entry.action,
          retentionRef: await storeBlob(root, entry.bytes)
        })
      }
      const manifest: ContentManifest = {
        formatVersion: 1,
        operationId: input.operationId,
        fingerprint: input.fingerprint,
        entries
      }
      await writeVersionValue(await manifestPath(root, input.operationId), manifest)
      return entries
    })
  }

  async release(input: VersionReleaseRequest): Promise<void> {
    requireOperationId(input.operationId)
    const root = await resolveProjectWorkRoot(this.userDirectory, input.projectId)
    await enqueueWorkWrite(root, async () => {
      const manifest = await readManifest(root, input.operationId)
      if (!manifest) return
      for (const retentionRef of input.retentionRefs) {
        if (!manifest.entries.some((entry) => entry.retentionRef === retentionRef)) continue
        if (await referencedElsewhere(root, input.operationId, retentionRef)) continue
        try {
          await rm(await blobPath(root, retentionRef), { force: true })
        } catch (error) {
          throw asGitException(
            error,
            ProjectVersioningErrorCodes.gitUnavailable,
            '内容保留无法释放'
          )
        }
      }
    })
  }
}

/** 按内容身份读回已保留字节。摘要对不上时失败，不用路径充当身份。 */
export async function readRetainedBlob(
  projectRoot: string,
  retentionRef: string
): Promise<Uint8Array> {
  if (!/^[0-9a-f]{64}$/u.test(retentionRef)) throw identityUnfixed()
  try {
    const bytes = new Uint8Array(await readFile(await blobPath(projectRoot, retentionRef)))
    if (digestBytes(bytes) !== retentionRef) throw identityUnfixed()
    return bytes
  } catch (error) {
    if (error instanceof AppException) throw error
    throw identityUnfixed()
  }
}

async function requestedRetentions(
  revisions: AiProjectFileSystemImpl,
  projectId: string,
  input: VersionRetainRequest
): Promise<
  readonly { relativePath: string; action: 'add' | 'modify' | 'delete'; bytes: Uint8Array | null }[]
> {
  if (input.input.kind === 'candidate') {
    return requestedCandidateRetentions(revisions, projectId, input.input)
  }
  const seen = new Set<string>()
  return input.input.changes.map((change) => {
    const relativePath = assertRelativePath(change.relativePath)
    if (seen.has(relativePath)) {
      throw new AppException({ code: ErrorCodes.invalidRequest, msg: '提交路径重复' })
    }
    seen.add(relativePath)
    if (change.action === 'delete') return { relativePath, action: change.action, bytes: null }
    if (change.content.kind !== 'bytes') throw identityUnfixed()
    return { relativePath, action: change.action, bytes: new Uint8Array(change.content.bytes) }
  })
}

async function requestedCandidateRetentions(
  revisions: AiProjectFileSystemImpl,
  projectId: string,
  input: ImmutableCandidateInputDTO
): Promise<
  readonly { relativePath: string; action: 'add' | 'modify' | 'delete'; bytes: Uint8Array | null }[]
> {
  const source = parseSceneCandidateRef(input.candidateRef)
  if (source.projectId !== projectId) throw identityUnfixed()
  const seen = new Set<string>()
  const entries: {
    relativePath: string
    action: 'add' | 'modify' | 'delete'
    bytes: Uint8Array | null
  }[] = []
  for (const change of input.changes) {
    const relativePath = assertRelativePath(change.relativePath)
    if (seen.has(relativePath)) {
      throw new AppException({ code: ErrorCodes.invalidRequest, msg: '提交路径重复' })
    }
    seen.add(relativePath)
    if (change.action === 'delete') {
      entries.push({ relativePath, action: change.action, bytes: null })
      continue
    }
    let bytes: Uint8Array | null
    try {
      bytes = await revisions.readRevisionFile({ ...source, relativePath })
    } catch {
      throw identityUnfixed()
    }
    if (!bytes) throw identityUnfixed()
    entries.push({ relativePath, action: change.action, bytes })
  }
  return entries
}

function parseSceneCandidateRef(candidateRef: string): {
  projectId: string
  threadId: string
  operationId: string
  revisionId: string
} {
  const parts = candidateRef.split('\0')
  if (
    parts.length !== 5 ||
    parts[0] !== 'scene-generation' ||
    !isCandidateIdentity(parts[1]) ||
    !isCandidateIdentity(parts[2]) ||
    !isCandidateIdentity(parts[3]) ||
    !/^[0-9a-f]{40}$/u.test(parts[4] ?? '')
  ) {
    throw identityUnfixed()
  }
  return {
    projectId: parts[1] ?? '',
    threadId: parts[2] ?? '',
    operationId: parts[3] ?? '',
    revisionId: parts[4] ?? ''
  }
}

function isCandidateIdentity(value: string | undefined): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 128 &&
    !value.includes('/') &&
    !value.includes('\\')
  )
}

async function storeBlob(projectRoot: string, bytes: Uint8Array): Promise<string> {
  const digest = digestBytes(bytes)
  const path = await blobPath(projectRoot, digest)
  try {
    const existing = new Uint8Array(await readFile(path))
    if (!bytesEqual(existing, bytes)) throw identityUnfixed()
    return digest
  } catch (error) {
    if (error instanceof AppException) throw error
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw asGitException(error, ProjectVersioningErrorCodes.gitUnavailable, '内容保留失败')
    }
  }
  await writeVerifiedBytes(path, bytes)
  return digest
}

async function readManifest(
  projectRoot: string,
  operationId: string
): Promise<ContentManifest | null> {
  const value = await readVersionValue(await manifestPath(projectRoot, operationId))
  if (value === null) return null
  const manifest = parseVersionValue(manifestSchema, value)
  if (manifest.operationId !== operationId) {
    throw new AppException({
      code: ProjectVersioningErrorCodes.gitQueryFailed,
      msg: '版本记录无法读取'
    })
  }
  return manifest
}

async function referencedElsewhere(
  projectRoot: string,
  operationId: string,
  retentionRef: string
): Promise<boolean> {
  const names = await listVersionDocuments(
    await versionDocumentPath(projectRoot, MANIFEST_DIRECTORY, '.')
  )
  for (const name of names) {
    const otherId = name.slice(0, -'.json'.length)
    if (otherId === operationId) continue
    if (!OPERATION_ID_PATTERN.test(otherId)) {
      throw new AppException({
        code: ProjectVersioningErrorCodes.gitQueryFailed,
        msg: '版本记录无法读取'
      })
    }
    const manifest = await readManifest(projectRoot, otherId)
    if (manifest?.entries.some((entry) => entry.retentionRef === retentionRef)) return true
  }
  return false
}

function sameEntries(
  stored: readonly VersionBoundRetention[],
  requested: readonly { relativePath: string; action: string }[]
): boolean {
  return (
    stored.length === requested.length &&
    stored.every(
      (entry, index) =>
        entry.relativePath === requested[index]?.relativePath &&
        entry.action === requested[index]?.action
    )
  )
}

function manifestPath(projectRoot: string, operationId: string): Promise<string> {
  return versionDocumentPath(projectRoot, MANIFEST_DIRECTORY, `${operationId}.json`)
}

function blobPath(projectRoot: string, retentionRef: string): Promise<string> {
  if (!/^[0-9a-f]{64}$/u.test(retentionRef)) throw identityUnfixed()
  return versionDocumentPath(projectRoot, OBJECT_DIRECTORY, retentionRef)
}

function identityUnfixed(): AppException {
  return new AppException({
    code: ProjectVersioningErrorCodes.invalidContentFingerprint,
    msg: '内容身份不能固定'
  })
}
