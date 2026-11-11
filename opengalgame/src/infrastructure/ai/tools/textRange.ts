import * as fs from 'node:fs/promises'

import { AppException } from '@common/errors/AppException'
import { ErrorCodes } from '@common/errors/ErrorCodes'

import { throwIfStopped } from '../execution/executionErrors'

const CHUNK_BYTES = 64 * 1024

export interface TextRange {
  content: string
  version: string
  start: number
  end: number
  charLength?: number
  complete: boolean
  truncated: boolean
}

/**
 * 先查看文件大小，再按码位范围读取，不把整个文件载入为结果。
 * @param start - 起始码位，从 0 开始。
 * @param maxChars - 最多返回的码位数。省略时读到文件结束。
 * @param signal - 取消信号。
 * @returns 范围内的文本、版本和是否截断。
 * @throws {AppException} 编码非法、读取失败或调用已取消。
 */
export async function readTextRange(
  absolutePath: string,
  start: number,
  maxChars: number | undefined,
  signal?: AbortSignal
): Promise<TextRange> {
  throwIfStopped(signal)
  const handle = await fs.open(absolutePath, 'r')
  let failed: unknown
  let result: TextRange | undefined
  try {
    const stat = await handle.stat()
    const decoded = await collectCodePoints(handle, stat.size, start, maxChars, signal)
    const truncated = !decoded.reachedEnd
    result = {
      content: decoded.content,
      version: `${stat.size}:${stat.mtimeMs}:${stat.ino}`,
      start,
      end: start + codePointLength(decoded.content),
      ...(decoded.reachedEnd ? { charLength: decoded.totalChars } : {}),
      complete: !truncated,
      truncated
    }
  } catch (error) {
    failed = error instanceof AppException ? error : decodeOrReadFailure(error)
  } finally {
    await closeHandle(handle, failed)
  }
  if (!result) {
    throw new AppException({ code: ErrorCodes.internalError, msg: '文件读取失败' })
  }
  return result
}

interface CollectedText {
  content: string
  reachedEnd: boolean
  totalChars: number
}

/**
 * 按块解码并只保留请求的码位。凑满范围后再多看一个码位，用来判断是否截断。
 * @param start - 起始码位。
 * @param maxChars - 最多保留的码位。
 * @param signal - 取消信号。
 * @returns 保留的文本，以及是否已经读到文件末尾。
 * @throws {AppException} 解码失败或调用已取消。
 */
async function collectCodePoints(
  handle: fs.FileHandle,
  size: number,
  start: number,
  maxChars: number | undefined,
  signal?: AbortSignal
): Promise<CollectedText> {
  const decoder = new TextDecoder('utf-8', { fatal: true })
  const buffer = Buffer.alloc(CHUNK_BYTES)
  const collected: string[] = []
  let position = 0
  let charIndex = 0
  let reachedEnd = true
  while (position < size) {
    throwIfStopped(signal)
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, position)
    if (bytesRead === 0) break
    position += bytesRead
    const chunk = decoder.decode(buffer.subarray(0, bytesRead), { stream: true })
    const stop = takePoints(chunk, collected, charIndex, start, maxChars)
    charIndex = stop.charIndex
    if (stop.filled) {
      reachedEnd = false
      break
    }
  }
  if (reachedEnd) {
    const tail = decoder.decode()
    const stop = takePoints(tail, collected, charIndex, start, maxChars)
    charIndex = stop.charIndex
    reachedEnd = !stop.filled
  }
  return {
    content: collected.join(''),
    reachedEnd,
    totalChars: reachedEnd ? charIndex : 0
  }
}

/**
 * 从一块已解码文本里收集仍需要的码位。
 * @param collected - 已经收集的码位。
 * @param charIndex - 当前文件中的码位位置。
 * @param start - 起始码位。
 * @param maxChars - 最多保留的码位。
 * @returns 新的码位位置，以及是否已经看到范围之后的字符。
 */
function takePoints(
  chunk: string,
  collected: string[],
  charIndex: number,
  start: number,
  maxChars: number | undefined
): { charIndex: number; filled: boolean } {
  let index = charIndex
  for (const point of chunk) {
    const limit = maxChars === undefined ? Number.POSITIVE_INFINITY : maxChars
    if (index >= start && collected.length < limit) collected.push(point)
    else if (index >= start) return { charIndex: index, filled: true }
    index += 1
  }
  return { charIndex: index, filled: false }
}

/**
 * 统计 Unicode 码位数量。
 * @returns 码位个数。
 */
function codePointLength(text: string): number {
  return [...text].length
}

function decodeOrReadFailure(error: unknown): AppException {
  if (error instanceof TypeError) {
    return new AppException({
      code: ErrorCodes.invalidRequest,
      msg: '文件不是合法的 UTF-8',
      cause: error
    })
  }
  return new AppException({ code: ErrorCodes.internalError, msg: '文件读取失败', cause: error })
}

/**
 * 关闭读取句柄。关闭失败时保留原始读取错误。
 * @param failed - 读取过程中的失败。
 * @throws {AppException} 句柄关闭失败，或原样抛出读取失败。
 */
async function closeHandle(handle: fs.FileHandle, failed: unknown): Promise<void> {
  try {
    await handle.close()
  } catch (error) {
    throw new AppException({
      code: ErrorCodes.internalError,
      msg: '文件句柄关闭失败',
      cause: failed === undefined ? error : new AggregateError([failed, error])
    })
  }
  if (failed !== undefined) throw failed
}
