import { resolveContained } from '../containedPath'
import { bytesEqual, decodeBytes, digestBytes } from '../objects/gitContent'
import type { GitEffects } from '../gitEffects'
import type { OperationRecord } from './OperationRecord'
import { readStageOids, readWorktreeBytes } from '../repository/WorkBaseline'

/**
 * 只恢复本操作改过、且当前内容仍属于本操作的文件和索引项。
 * @param record - 含原始字节和暂存 OID 的记录。
 * @param appliedStageOids - 本操作已经写入索引的路径及其 OID。尚未写入的路径不在其中。
 * @throws {AppException} 当前内容已不属于本操作，或恢复失败。
 */
export async function restoreRecordedFiles(
  projectRoot: string,
  record: OperationRecord,
  effects: GitEffects,
  appliedStageOids: ReadonlyMap<string, string | null>
): Promise<void> {
  const stageOids = await readStageOids(
    projectRoot,
    record.paths.map((path) => path.relativePath)
  )
  for (const path of record.paths) {
    await restoreFile(projectRoot, path, effects)
    await restoreStage(
      projectRoot,
      path,
      stageOids.get(path.relativePath) ?? null,
      appliedStageOids,
      effects
    )
  }
}

/**
 * 回退发布前失败时，只把本操作路径恢复到回退开始时的文件和索引项。
 * @param record - 回退记录。
 * @param forwardFiles - 回退开始时这些路径的字节。
 * @param stageBefore - 回退开始时这些路径的暂存 OID。
 * @param appliedStageOids - 回退已经写入索引的路径及其 OID。
 * @throws {AppException} 当前内容已不属于本操作，或恢复失败。
 */
export async function restoreForwardFiles(
  projectRoot: string,
  record: OperationRecord,
  forwardFiles: readonly { relativePath: string; bytes: Uint8Array | null }[],
  stageBefore: ReadonlyMap<string, string | null>,
  appliedStageOids: ReadonlyMap<string, string | null>,
  effects: GitEffects
): Promise<void> {
  const stageOids = await readStageOids(
    projectRoot,
    forwardFiles.map((file) => file.relativePath)
  )
  for (const file of forwardFiles) {
    const absolute = await resolveContained(projectRoot, file.relativePath)
    const current = await readWorktreeBytes(projectRoot, file.relativePath)
    if (!sameBytes(current, file.bytes)) {
      const path = record.paths.find((item) => item.relativePath === file.relativePath)
      const original = path?.originalBytesBase64 ? decodeBytes(path.originalBytesBase64) : null
      if (!sameBytes(current, original)) throw foreignChange()
      if (file.bytes === null) await effects.removeFile(absolute)
      else await effects.writeBytes(absolute, file.bytes)
    }
    const currentOid = stageOids.get(file.relativePath) ?? null
    const before = stageBefore.get(file.relativePath) ?? null
    const applied = appliedStageOids.get(file.relativePath)
    if (currentOid === before) continue
    if (applied !== undefined && currentOid === applied) {
      await effects.stageBlob(projectRoot, file.relativePath, before)
      continue
    }
    throw foreignChange()
  }
}

async function restoreFile(
  projectRoot: string,
  path: OperationRecord['paths'][number],
  effects: GitEffects
): Promise<void> {
  const absolute = await resolveContained(projectRoot, path.relativePath)
  const original = path.originalBytesBase64 === null ? null : decodeBytes(path.originalBytesBase64)
  if (path.originalBytesBase64 !== null && !original) throw new Error('原始字节无法还原')
  const current = await readWorktreeBytes(projectRoot, path.relativePath)
  if (sameBytes(current, original)) return
  const currentDigest = current ? digestBytes(current) : null
  if (currentDigest !== path.intendedDigest) throw foreignChange()
  if (original === null) await effects.removeFile(absolute)
  else await effects.writeBytes(absolute, original)
}

async function restoreStage(
  projectRoot: string,
  path: OperationRecord['paths'][number],
  currentOid: string | null,
  appliedStageOids: ReadonlyMap<string, string | null>,
  effects: GitEffects
): Promise<void> {
  if (currentOid === path.originalStageOid) return
  const applied = appliedStageOids.get(path.relativePath)
  if (applied !== undefined && currentOid === applied) {
    await effects.stageBlob(projectRoot, path.relativePath, path.originalStageOid)
    return
  }
  throw foreignChange()
}

function sameBytes(left: Uint8Array | null, right: Uint8Array | null): boolean {
  if (left === null || right === null) return left === right
  return bytesEqual(left, right)
}

function foreignChange(): Error {
  return new Error('文件或索引已有其他修改，不能恢复')
}
