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
