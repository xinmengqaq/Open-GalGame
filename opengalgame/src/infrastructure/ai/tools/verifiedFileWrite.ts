import { randomUUID } from 'node:crypto'
import * as fs from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { AppException } from '@common/errors/AppException'
import { ErrorCodes } from '@common/errors/ErrorCodes'

import { throwIfStopped } from '../execution/executionErrors'

/**
 * 把字节写入目标文件。临时文件与目标位于同一目录，写入后回读核对再改名。
 * 取消和失败都以目标文件的实际结果为准，不自动重试。
 * @param signal - 取消信号。改名之前中止则保留原目标。
 * @throws {AppException} 写入、核对、取消或临时文件清理失败。
 */
export async function writeVerifiedBytes(
  absolutePath: string,
  bytes: Uint8Array,
  signal?: AbortSignal
): Promise<void> {
  throwIfStopped(signal)
  const temporary = join(dirname(absolutePath), `.opengalgame-tmp-${randomUUID()}`)
  let handle: fs.FileHandle | undefined
  let failed: unknown
  try {
    await fs.mkdir(dirname(absolutePath), { recursive: true })
    throwIfStopped(signal)
    handle = await fs.open(temporary, 'wx')
    await handle.write(bytes)
    await handle.sync()
    await handle.close()
    handle = undefined
    throwIfStopped(signal)
    const written = new Uint8Array(await fs.readFile(temporary))
    if (!bytesEqual(written, bytes)) {
      throw new AppException({
        code: ErrorCodes.internalError,
        msg: '文件写入后与内容不一致'
      })
    }
    throwIfStopped(signal)
    await fs.rename(temporary, absolutePath)
  } catch (error) {
    failed = error
  } finally {
    await releaseWrite(handle, temporary, absolutePath, failed)
  }
}

/**
 * 关闭句柄并清理尚未改名的临时文件。清理失败不吞掉。
 * @param handle - 仍打开的临时文件句柄。
 * @param failed - 写入过程中的原始失败。
 * @throws {AppException} 句柄关闭或临时文件清理失败，或原样抛出写入失败。
 */
async function releaseWrite(
  handle: fs.FileHandle | undefined,
  temporary: string,
  absolutePath: string,
  failed: unknown
): Promise<void> {
  const cleanup: unknown[] = []
  if (handle) {
    try {
      await handle.close()
    } catch (error) {
      cleanup.push(error)
    }
  }
  if (failed !== undefined && temporary !== absolutePath) {
    try {
      await fs.rm(temporary, { force: true })
    } catch (error) {
      cleanup.push(error)
    }
  }
  if (cleanup.length > 0) {
    throw new AppException({
      code: ErrorCodes.internalError,
      msg: '文件写入失败，临时文件或句柄未能清理',
      cause: failed === undefined ? firstCause(cleanup) : new AggregateError([failed, ...cleanup])
    })
  }
  if (failed !== undefined) throw asFileFailure(failed)
}

function asFileFailure(error: unknown): AppException {
  if (error instanceof AppException) return error
  return new AppException({ code: ErrorCodes.internalError, msg: '文件写入失败', cause: error })
}

/**
 * 取清理失败列表中的第一个原因。
 * @param errors - 关闭或删除失败。
 * @returns 第一个失败。
 */
function firstCause(errors: unknown[]): unknown {
  return errors.length === 1 ? errors[0] : new AggregateError(errors)
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false
  }
  return true
}
